//! Socket unix : une requête JSON par connexion, une réponse JSON en retour.

use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::Path;
use std::time::Duration;

use helm_protocol::{Request, Response};

use crate::collector::now_ms;
use crate::state::{self, Shared};

pub fn serve(path: &Path, state: Shared) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let _ = std::fs::remove_file(path);
    let listener = UnixListener::bind(path)?;
    // Lecture seule des métriques : accessible à tout utilisateur local (les secrets restent dans la config).
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o666))?;
    for stream in listener.incoming().flatten() {
        let s = state.clone();
        std::thread::spawn(move || handle(stream, s));
    }
    Ok(())
}

fn handle(stream: UnixStream, state: Shared) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let mut line = String::new();
    if BufReader::new((&stream).take(64 * 1024)).read_line(&mut line).is_err() {
        return;
    }
    let response = match serde_json::from_str::<Request>(line.trim()) {
        Ok(req) => answer(req, &state),
        Err(e) => Response::Error { message: format!("requête invalide : {e}") },
    };
    let mut out = serde_json::to_vec(&response).unwrap_or_default();
    out.push(b'\n');
    let _ = (&stream).write_all(&out);
}

fn answer(req: Request, state: &Shared) -> Response {
    match req {
        Request::Status => Response::Status(Box::new(state.lock().unwrap().status())),
        Request::Live { count } => {
            let s = state.lock().unwrap();
            let skip = s.history.live.len().saturating_sub(count);
            Response::Live { metrics: s.history.live.iter().skip(skip).cloned().collect() }
        }
        Request::History { range_secs, points } => {
            let s = state.lock().unwrap();
            Response::History { points: s.history.range(now_ms(), range_secs, points.clamp(10, 2000)) }
        }
        Request::TestNotify => match state::test_notify(state) {
            Ok(message) => Response::Ok { message },
            Err(message) => Response::Error { message },
        },
    }
}
