//! トークン認証(2.4, 7.8)。URL のトークンを Cookie に移し、以降は Cookie で確かめる

use std::sync::Arc;

use axum::extract::{Request, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};

use crate::App;

pub(crate) async fn require_token(
    State(app): State<Arc<App>>,
    req: Request,
    next: Next,
) -> Response {
    // トークン付き URL: 正しければ Cookie を渡し、トークンを消した URL へ移す
    let current = app.token();
    if let Some((token, rest)) = split_token(req.uri().query()) {
        if !eq(&token, &current) {
            return unauthorized();
        }
        let location = match rest {
            Some(q) => format!("{}?{q}", req.uri().path()),
            None => req.uri().path().to_owned(),
        };
        let cookie = format!(
            "{}={}; Path=/; HttpOnly; Secure; SameSite=Strict",
            cookie_name(&app.instance_id),
            current
        );
        return (
            StatusCode::SEE_OTHER,
            [(header::LOCATION, location), (header::SET_COOKIE, cookie)],
        )
            .into_response();
    }
    if authorized(req.headers(), &app.instance_id, &current) {
        next.run(req).await
    } else {
        unauthorized()
    }
}

/// 同じホストの複数コンテナで衝突しないよう、Cookie 名にインスタンス ID を含める
fn cookie_name(instance_id: &str) -> String {
    format!("dew_{instance_id}")
}

fn authorized(headers: &HeaderMap, instance_id: &str, token: &str) -> bool {
    // CLI は Authorization ヘッダで送る
    if let Some(v) = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        && let Some(t) = v.strip_prefix("Bearer ")
    {
        return eq(t, token);
    }
    let name = cookie_name(instance_id);
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .filter_map(|kv| kv.trim().split_once('='))
        .any(|(k, v)| k == name && eq(v, token))
}

/// クエリから token を取り出し、残りのクエリと一緒に返す
fn split_token(query: Option<&str>) -> Option<(String, Option<String>)> {
    let query = query?;
    let mut token = None;
    let mut rest = Vec::new();
    for kv in query.split('&') {
        match kv.strip_prefix("token=") {
            Some(t) => token = Some(t.to_owned()),
            None => rest.push(kv),
        }
    }
    let rest = (!rest.is_empty()).then(|| rest.join("&"));
    token.map(|t| (t, rest))
}

/// 比較にかかる時間から一致した長さが分からないようにする
fn eq(a: &str, b: &str) -> bool {
    a.len() == b.len()
        && a.bytes()
            .zip(b.bytes())
            .fold(0u8, |acc, (x, y)| acc | (x ^ y))
            == 0
}

fn unauthorized() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        [(
            header::CONTENT_TYPE,
            HeaderValue::from_static("text/plain; charset=utf-8"),
        )],
        "dew: トークンがないか、正しくありません。端末に表示された URL から開いてください\n",
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_token_keeps_other_params() {
        assert_eq!(split_token(Some("token=abc")), Some(("abc".into(), None)));
        assert_eq!(
            split_token(Some("path=%2Fa&token=abc&x=1")),
            Some(("abc".into(), Some("path=%2Fa&x=1".into())))
        );
        assert_eq!(split_token(Some("path=a")), None);
        assert_eq!(split_token(None), None);
    }

    #[test]
    fn eq_is_exact() {
        assert!(eq("abc", "abc"));
        assert!(!eq("abc", "abd"));
        assert!(!eq("abc", "ab"));
    }
}
