//! Socket unix : une requête JSON par connexion, une réponse JSON en retour.

use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
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
    // Métriques lisibles par tout utilisateur local (Helm s'y connecte sans sudo). Les URL de
    // notification et l'envoi de test sont réservés à root, vérifié sur l'identité du client.
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o666))?;
    let active = Arc::new(AtomicUsize::new(0));
    for stream in listener.incoming().flatten() {
        // Un client local ne peut pas épuiser les threads de l'agent.
        if active.load(Ordering::Relaxed) >= MAX_CLIENTS {
            continue;
        }
        active.fetch_add(1, Ordering::Relaxed);
        let (s, a) = (state.clone(), active.clone());
        std::thread::spawn(move || {
            handle(stream, s);
            a.fetch_sub(1, Ordering::Relaxed);
        });
    }
    Ok(())
}

const MAX_CLIENTS: usize = 16;

/// UID du processus client, lu sur le socket (SO_PEERCRED).
fn peer_uid(stream: &UnixStream) -> Option<u32> {
    use std::os::fd::AsRawFd;
    let mut cred = libc::ucred { pid: 0, uid: u32::MAX, gid: 0 };
    let mut len = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    // SAFETY : `cred` et `len` sont valides et dimensionnés pour SO_PEERCRED.
    let rc = unsafe {
        libc::getsockopt(stream.as_raw_fd(), libc::SOL_SOCKET, libc::SO_PEERCRED, (&mut cred as *mut libc::ucred).cast(), &mut len)
    };
    (rc == 0).then_some(cred.uid)
}

fn handle(stream: UnixStream, state: Shared) {
    let privileged = peer_uid(&stream) == Some(0);
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let mut line = String::new();
    if BufReader::new((&stream).take(64 * 1024)).read_line(&mut line).is_err() {
        return;
    }
    let response = match serde_json::from_str::<Request>(line.trim()) {
        Ok(req) => answer(req, &state, privileged),
        Err(e) => Response::Error { message: format!("requête invalide : {e}") },
    };
    let mut out = serde_json::to_vec(&response).unwrap_or_default();
    out.push(b'\n');
    let _ = (&stream).write_all(&out);
}

fn answer(req: Request, state: &Shared, privileged: bool) -> Response {
    match req {
        Request::Status => {
            let mut status = state.lock().unwrap().status();
            if !privileged {
                status.config.notifiers = status.config.notifiers.redacted();
            }
            Response::Status(Box::new(status))
        }
        Request::Live { count } => {
            let s = state.lock().unwrap();
            let skip = s.history.live.len().saturating_sub(count);
            Response::Live { metrics: s.history.live.iter().skip(skip).cloned().collect() }
        }
        Request::History { range_secs, points } => {
            let s = state.lock().unwrap();
            Response::History { points: s.history.range(now_ms(), range_secs, points.clamp(10, 2000)) }
        }
        Request::TestNotify if !privileged => Response::Error { message: "envoi de test réservé à root (sudo)".into() },
        Request::TestNotify => match state::test_notify(state) {
            Ok(message) => Response::Ok { message },
            Err(message) => Response::Error { message },
        },
    }
}
