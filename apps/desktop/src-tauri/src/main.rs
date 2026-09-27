// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // `Zenytt --mcp` : serveur MCP en lecture seule sur stdin/stdout, sans interface graphique.
    if std::env::args().any(|a| a == "--mcp") {
        let rt = tokio::runtime::Runtime::new().expect("runtime tokio");
        if let Err(e) = rt.block_on(zenytt_mcp::serve_stdio()) {
            eprintln!("zenytt --mcp : {e}");
            std::process::exit(1);
        }
        return;
    }
    zenytt_desktop_lib::run()
}
