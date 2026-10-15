//! 自己署名証明書(ECDSA)。初回に作って保存し、以降は再利用する(9.1)

use std::fs;
use std::io::Write;
use std::net::UdpSocket;
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;

use anyhow::Context;
use axum_server::tls_rustls::RustlsConfig;

pub(crate) async fn load_or_create(
    dir: &Path,
    public_host: Option<&str>,
) -> anyhow::Result<RustlsConfig> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let cert_path = dir.join("cert.pem");
    let key_path = dir.join("key.pem");
    if !cert_path.exists() || !key_path.exists() {
        create(dir, public_host)?;
    }
    let cert =
        fs::read(&cert_path).with_context(|| format!("{} を読めません", cert_path.display()))?;
    let key =
        fs::read(&key_path).with_context(|| format!("{} を読めません", key_path.display()))?;
    RustlsConfig::from_pem(cert, key)
        .await
        .context("証明書を読み込めません")
}

/// 対象名はホスト名、コンテナの IP、DEW_PUBLIC_HOST、localhost
fn create(dir: &Path, public_host: Option<&str>) -> anyhow::Result<()> {
    let mut names = vec![
        "localhost".to_owned(),
        "127.0.0.1".to_owned(),
        crate::hostname(),
    ];
    if let Some(ip) = primary_ip() {
        names.push(ip);
    }
    if let Some(h) = public_host {
        names.push(h.to_owned());
    }
    names.dedup();
    let certified = rcgen::generate_simple_self_signed(names).context("証明書を作れません")?;

    fs::create_dir_all(dir).with_context(|| format!("{} を作れません", dir.display()))?;
    fs::write(dir.join("cert.pem"), certified.cert.pem())?;
    // 鍵は本人だけが読めるようにする
    fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(dir.join("key.pem"))?
        .write_all(certified.signing_key.serialize_pem().as_bytes())?;
    tracing::info!(dir = %dir.display(), "自己署名証明書を作りました");
    Ok(())
}

/// 外向きの通信に使うアドレス(パケットは送らない)
fn primary_ip() -> Option<String> {
    let s = UdpSocket::bind("0.0.0.0:0").ok()?;
    s.connect("192.0.2.1:9").ok()?;
    Some(s.local_addr().ok()?.ip().to_string())
}
