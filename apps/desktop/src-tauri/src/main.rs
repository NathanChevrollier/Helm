// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // `Helm --mcp` : serveur MCP en lecture seule sur stdin/stdout, sans interface graphique.
    if std::env::args().any(|a| a == "--mcp") {
        let rt = tokio::runtime::Runtime::new().expect("runtime tokio");
        if let Err(e) = rt.block_on(helm_mcp::serve_stdio()) {
            eprintln!("helm --mcp : {e}");
            std::process::exit(1);
        }
        return;
    }
    helm_desktop_lib::run()
}
