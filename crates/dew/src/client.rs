//! 起動中のサーバへの問い合わせ(CLI から使う)

use std::time::Duration;

use dew_protocol::{OpenRequest, OpenResponse};
use reqwest::blocking::Client;

use crate::state::ServerFile;

pub struct Api {
    client: Client,
    base: String,
    token: String,
}

impl Api {
    pub fn new(s: &ServerFile) -> Self {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let client = Client::builder()
            // 自分のサーバの自己署名証明書を、ループバックで確かめるだけなので検証しない
            .danger_accept_invalid_certs(true)
            .timeout(Duration::from_secs(5))
            .build()
            .expect("HTTP クライアントを作れません");
        Self {
            client,
            base: format!("https://{}:{}", s.local_host, s.port),
            token: s.token.clone(),
        }
    }

    /// サーバが応答し、記録と同じインスタンスか
    pub fn alive(&self, instance_id: &str) -> bool {
        let res = self
            .client
            .get(format!("{}/api/health", self.base))
            .bearer_auth(&self.token)
            .send();
        let Ok(res) = res else { return false };
        let Ok(body) = res.json::<serde_json::Value>() else {
            return false;
        };
        body["instanceId"] == instance_id
    }

    pub fn open(&self, path: &str) -> anyhow::Result<OpenResponse> {
        Ok(self
            .client
            .post(format!("{}/api/open", self.base))
            .bearer_auth(&self.token)
            .json(&OpenRequest {
                path: path.to_owned(),
            })
            .send()?
            .error_for_status()?
            .json()?)
    }

    pub fn shutdown(&self) -> anyhow::Result<()> {
        self.client
            .post(format!("{}/api/shutdown", self.base))
            .bearer_auth(&self.token)
            .send()?
            .error_for_status()?;
        Ok(())
    }
}
