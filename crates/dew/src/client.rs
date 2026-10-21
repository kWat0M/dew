//! 起動中のサーバへの問い合わせ(CLI から使う)

use std::time::Duration;

use dew_protocol::{
    Info, LiveSession, OpenRequest, OpenResponse, RotateTokenResponse, ShellCount, ShellRequest,
};
use reqwest::blocking::Client;

use crate::state::ServerFile;

pub enum OpenError {
    /// 閲覧範囲の外
    OutsideRoot,
    Other(anyhow::Error),
}

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

    pub fn open(&self, path: &str) -> Result<OpenResponse, OpenError> {
        let res = self
            .client
            .post(format!("{}/api/open", self.base))
            .bearer_auth(&self.token)
            .json(&OpenRequest {
                path: path.to_owned(),
            })
            .send()
            .map_err(|e| OpenError::Other(e.into()))?;
        if res.status() == reqwest::StatusCode::FORBIDDEN {
            return Err(OpenError::OutsideRoot);
        }
        let res = res
            .error_for_status()
            .map_err(|e| OpenError::Other(e.into()))?;
        res.json().map_err(|e| OpenError::Other(e.into()))
    }

    /// サーバの閲覧範囲の起点
    pub fn root(&self) -> Option<String> {
        let res = self
            .client
            .get(format!("{}/api/info", self.base))
            .bearer_auth(&self.token)
            .send()
            .ok()?;
        Some(res.json::<Info>().ok()?.root)
    }

    /// ライブ描画のセッションにつなぐ設定(なければサーバが作る)
    pub fn live_session(&self) -> anyhow::Result<LiveSession> {
        let res = self
            .client
            .post(format!("{}/api/live/session", self.base))
            .bearer_auth(&self.token)
            // 仮想ディスプレイと音声サーバの起動を待つ
            .timeout(Duration::from_secs(30))
            .send()?;
        // 失敗したら、HTTP の番号ではなくサーバの説明を出す
        if !res.status().is_success() {
            let msg = res.text().unwrap_or_default();
            anyhow::bail!("ライブ描画を始められません: {}", msg.trim());
        }
        Ok(res.json()?)
    }

    /// activate / deactivate したシェルを登録する・取り消す(13.6)
    pub fn shell(&self, pid: u32, active: bool) -> anyhow::Result<()> {
        self.client
            .post(format!("{}/api/shell", self.base))
            .bearer_auth(&self.token)
            .json(&ShellRequest { pid, active })
            .send()?
            .error_for_status()?;
        Ok(())
    }

    /// activate 中のシェルの数
    pub fn shells(&self) -> anyhow::Result<u32> {
        let res = self
            .client
            .get(format!("{}/api/shells", self.base))
            .bearer_auth(&self.token)
            .send()?
            .error_for_status()?;
        Ok(res.json::<ShellCount>()?.count)
    }

    pub fn rotate_token(&self) -> anyhow::Result<String> {
        let res = self
            .client
            .post(format!("{}/api/rotate-token", self.base))
            .bearer_auth(&self.token)
            .send()?
            .error_for_status()?;
        Ok(res.json::<RotateTokenResponse>()?.token)
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
