//! `helm-mcp` : exécutable autonome du serveur MCP (l'app Helm le fournit aussi via `Helm --mcp`).

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    helm_mcp::serve_stdio().await
}
