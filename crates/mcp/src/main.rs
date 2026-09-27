//! `zenytt-mcp` : exécutable autonome du serveur MCP (l'app Zenytt le fournit aussi via `Zenytt --mcp`).

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    zenytt_mcp::serve_stdio().await
}
