//! État partagé de l'agent et boucles de travail (collecte, supervision HTTP, persistance).

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use helm_protocol::{AgentConfig, AgentStatus, AlertEvent, RawSample};

use crate::alerts::{Evaluator, Transition};
use crate::collector::{self, now_ms};
use crate::history::History;
use crate::notify;

pub struct Paths {
    pub config: PathBuf,
    pub data_dir: PathBuf,
    pub socket: PathBuf,
}

pub struct State {
    pub config: AgentConfig,
    pub config_error: Option<String>,
    config_mtime: Option<SystemTime>,
    pub history: History,
    pub alerts: Evaluator,
    pub started_at: i64,
    pub hostname: String,
}

pub type Shared = Arc<Mutex<State>>;

impl State {
    pub fn server_name(&self) -> String {
        self.config.server_name.clone().filter(|s| !s.trim().is_empty()).unwrap_or_else(|| self.hostname.clone())
    }

    pub fn status(&self) -> AgentStatus {
        AgentStatus {
            version: env!("CARGO_PKG_VERSION").into(),
            protocol: helm_protocol::PROTOCOL_VERSION,
            started_at: self.started_at,
            hostname: self.hostname.clone(),
            config: self.config.clone(),
            config_error: self.config_error.clone(),
            active_alerts: self.alerts.active.values().cloned().collect(),
            recent_events: self.history.events.iter().rev().take(50).cloned().collect(),
            latest: self.history.latest().cloned(),
        }
    }

    /// Recharge la configuration si le fichier a changé. Une configuration invalide est ignorée
    /// (on garde la précédente) et l'erreur est exposée dans le statut.
    fn reload_config(&mut self, path: &PathBuf) {
        let mtime = std::fs::metadata(path).and_then(|m| m.modified()).ok();
        if mtime.is_some() && mtime == self.config_mtime {
            return;
        }
        self.config_mtime = mtime;
        match std::fs::read(path) {
            Ok(bytes) => match serde_json::from_slice::<AgentConfig>(&bytes) {
                Ok(cfg) => {
                    self.config = cfg;
                    self.config_error = None;
                }
                Err(e) => self.config_error = Some(format!("configuration invalide : {e}")),
            },
            Err(_) => {
                self.config = AgentConfig::default();
                self.config_error = None;
            }
        }
    }

    fn record(&mut self, t: &Transition) -> (String, String, bool) {
        let (alert, resolved) = match t {
            Transition::Fired(a) => (a, false),
            Transition::Resolved(a) => (a, true),
        };
        self.history.event(AlertEvent {
            t: now_ms(),
            key: alert.key.clone(),
            title: alert.title.clone(),
            message: alert.message.clone(),
            resolved,
        });
        (alert.title.clone(), alert.message.clone(), resolved)
    }
}

/// Notifie hors du verrou pour ne pas bloquer les requêtes pendant les appels réseau.
fn dispatch(state: &Shared, transitions: Vec<Transition>) {
    if transitions.is_empty() {
        return;
    }
    let (notifiers, messages) = {
        let mut s = state.lock().unwrap();
        let msgs: Vec<_> = transitions.iter().map(|t| s.record(t)).collect();
        (s.config.notifiers.clone(), msgs)
    };
    for (title, message, resolved) in messages {
        for e in notify::send(&notifiers, &title, &message, resolved) {
            eprintln!("notification échouée : {e}");
        }
    }
}

pub fn start(paths: Paths) -> Result<(), String> {
    std::fs::create_dir_all(&paths.data_dir).map_err(|e| format!("{} : {e}", paths.data_dir.display()))?;
    let history_path = paths.data_dir.join("history.json");

    let mut initial = State {
        config: AgentConfig::default(),
        config_error: None,
        config_mtime: None,
        history: History::new(5),
        alerts: Evaluator::default(),
        started_at: now_ms(),
        hostname: collector::hostname(),
    };
    initial.reload_config(&paths.config);
    initial.history = History::new(initial.config.sample_interval_secs);
    initial.history.load(&history_path, now_ms());
    let state: Shared = Arc::new(Mutex::new(initial));

    #[cfg(unix)]
    {
        let s = state.clone();
        let socket = paths.socket.clone();
        std::thread::spawn(move || {
            if let Err(e) = crate::server::serve(&socket, s) {
                eprintln!("socket indisponible : {e}");
                std::process::exit(1);
            }
        });
    }

    // Supervision HTTP des sites.
    {
        let s = state.clone();
        std::thread::spawn(move || loop {
            let (checks, interval, server) = {
                let st = s.lock().unwrap();
                (st.config.http_checks.clone(), st.config.http_check_interval_secs.max(10), st.server_name())
            };
            let mut transitions = Vec::new();
            for c in checks.iter().filter(|c| c.enabled) {
                let result = notify::probe(&c.url);
                if let Some(t) = s.lock().unwrap().alerts.http_result(&c.name, &c.url, result, now_ms(), &server) {
                    transitions.push(t);
                }
            }
            dispatch(&s, transitions);
            std::thread::sleep(Duration::from_secs(interval));
        });
    }

    eprintln!("helmd {} démarré, socket {}", env!("CARGO_PKG_VERSION"), paths.socket.display());
    let mut prev: Option<RawSample> = None;
    let mut last_save = now_ms();
    loop {
        let raw = collector::sample();
        let transitions = {
            let mut s = state.lock().unwrap();
            s.reload_config(&paths.config);
            let metrics = helm_protocol::compute(prev.as_ref(), &raw);
            // Le premier relevé n'a pas de CPU calculable : on ne l'enregistre pas.
            if prev.is_some() {
                s.history.push(metrics.clone());
            }
            let server = s.server_name();
            let cfg = s.config.clone();
            if prev.is_some() {
                s.alerts.evaluate(&cfg, &metrics, &server)
            } else {
                Vec::new()
            }
        };
        prev = Some(raw);
        dispatch(&state, transitions);

        if now_ms() - last_save > 5 * 60_000 {
            if let Err(e) = state.lock().unwrap().history.save(&history_path) {
                eprintln!("sauvegarde de l'historique impossible : {e}");
            }
            last_save = now_ms();
        }
        let interval = state.lock().unwrap().config.sample_interval_secs.clamp(1, 60);
        std::thread::sleep(Duration::from_secs(interval));
    }
}

/// Envoie une notification de test et renvoie le résultat lisible.
pub fn test_notify(state: &Shared) -> Result<String, String> {
    let (notifiers, server) = {
        let s = state.lock().unwrap();
        (s.config.notifiers.clone(), s.server_name())
    };
    if !notify::any_configured(&notifiers) {
        return Err("aucun canal de notification configuré".into());
    }
    let errors = notify::send(&notifiers, &format!("{server} : notification de test"), "Helm est bien configuré pour t'alerter.", true);
    if errors.is_empty() {
        Ok("notification envoyée".into())
    } else {
        Err(errors.join(" ; "))
    }
}
