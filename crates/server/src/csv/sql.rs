//! 大規模モードの SQL を組み立てる(16.5)。クライアントから SQL は受け取らず、列は番号で受ける。
//! テーブルの列名は dew が付けた `c0`, `c1`, …(元の値の文字列)と、数値・真偽値の列の `n0`, …(型付きの値)なので、
//! 利用者の列名が SQL に入ることはない。値はすべて `$N` のパラメータとして渡す。
//! 比べ方はブラウザ(web/src/csv/compare.ts)と同じにする: 数値・真偽値は値、日付は文字列、文字列は小文字にして
//! コードポイント順(DuckDB の VARCHAR の比較は UTF-8 のバイト順 = コードポイント順)。null は末尾、同じ値は元の行番号の順

use dew_protocol::{CsvColumn, CsvFilter, CsvFilterOp, CsvSort, CsvType};
use duckdb::types::Value;

use crate::files::ApiError;

/// 型付きの列(`n{i}`)を持つ型
pub(crate) fn typed(ty: CsvType) -> Option<&'static str> {
    match ty {
        CsvType::Integer => Some("BIGINT"),
        CsvType::Float => Some("DOUBLE"),
        CsvType::Boolean => Some("BOOLEAN"),
        CsvType::Date | CsvType::String => None,
    }
}

/// 並べ替えに使う式
fn sort_expr(i: usize, ty: CsvType) -> String {
    match ty {
        CsvType::Integer | CsvType::Float | CsvType::Boolean => format!("n{i}"),
        CsvType::Date => format!("c{i}"),
        CsvType::String => format!("lower(c{i})"),
    }
}

/// パラメータを足しながら式を作る
#[derive(Default)]
pub(crate) struct Params(pub Vec<Value>);

impl Params {
    fn push(&mut self, v: Value) -> String {
        self.0.push(v);
        format!("${}", self.0.len())
    }
}

fn column(cols: &[CsvColumn], col: u32) -> Result<(usize, &CsvColumn), ApiError> {
    let i = col as usize;
    cols.get(i)
        .map(|c| (i, c))
        .ok_or_else(|| ApiError::BadRequest(format!("列 {col} はありません")))
}

fn number(v: &str) -> Result<Value, ApiError> {
    v.trim()
        .parse::<f64>()
        .ok()
        .filter(|f| f.is_finite())
        .map(Value::Double)
        .ok_or_else(|| ApiError::BadRequest(format!("数値ではありません: {v}")))
}

/// `WHERE` の中身(条件がなければ `true`)。複数の列の条件は AND
pub(crate) fn filters(
    cols: &[CsvColumn],
    filters: &[CsvFilter],
    p: &mut Params,
) -> Result<String, ApiError> {
    let mut parts = Vec::new();
    for f in filters {
        let (i, c) = column(cols, f.col)?;
        let num = matches!(c.ty, CsvType::Integer | CsvType::Float);
        // 数値は n{i} を数として、日付は c{i} を文字列のまま比べる
        let target = if num {
            format!("n{i}")
        } else {
            format!("c{i}")
        };
        let value = |p: &mut Params, v: &str| -> Result<String, ApiError> {
            Ok(if num {
                p.push(number(v)?)
            } else {
                p.push(Value::Text(v.to_owned()))
            })
        };
        let lower = |p: &mut Params, v: &str| p.push(Value::Text(v.to_lowercase()));
        let cmp = |p: &mut Params, op: &str| -> Result<String, ApiError> {
            Ok(format!("{target} {op} {}", value(p, &f.value)?))
        };
        let part = match (f.op, c.ty) {
            (CsvFilterOp::Empty, _) => format!("c{i} IS NULL"),
            (CsvFilterOp::NotEmpty, _) => format!("c{i} IS NOT NULL"),
            (CsvFilterOp::Contains, _) => format!("contains(lower(c{i}), {})", lower(p, &f.value)),
            (CsvFilterOp::Equals, _) => format!("lower(c{i}) = {}", lower(p, &f.value)),
            (CsvFilterOp::StartsWith, _) => {
                format!("starts_with(lower(c{i}), {})", lower(p, &f.value))
            }
            (CsvFilterOp::True, _) => format!("lower(c{i}) = 'true'"),
            (CsvFilterOp::False, _) => format!("lower(c{i}) = 'false'"),
            (_, CsvType::Boolean | CsvType::String) => {
                return Err(ApiError::BadRequest(format!(
                    "{} の列では大小を比べられません",
                    c.name
                )));
            }
            (CsvFilterOp::Eq, _) => cmp(p, "=")?,
            (CsvFilterOp::Ne, _) => cmp(p, "<>")?,
            (CsvFilterOp::Lt, _) => cmp(p, "<")?,
            (CsvFilterOp::Le, _) => cmp(p, "<=")?,
            (CsvFilterOp::Gt, _) => cmp(p, ">")?,
            (CsvFilterOp::Ge, _) => cmp(p, ">=")?,
            (CsvFilterOp::Between, _) => {
                let lo = value(p, &f.value)?;
                let hi = value(p, &f.value2)?;
                format!("{target} BETWEEN {lo} AND {hi}")
            }
        };
        parts.push(format!("({part})"));
    }
    Ok(if parts.is_empty() {
        "true".into()
    } else {
        parts.join(" AND ")
    })
}

/// `ORDER BY` の中身。最後に元の行番号を足して、同じ値の行の順を決める
pub(crate) fn order(cols: &[CsvColumn], sort: &[CsvSort]) -> Result<String, ApiError> {
    let mut parts = Vec::new();
    for s in sort {
        let (i, c) = column(cols, s.col)?;
        parts.push(format!(
            "{} {} NULLS LAST",
            sort_expr(i, c.ty),
            if s.desc { "DESC" } else { "ASC" }
        ));
    }
    parts.push("__row ASC".into());
    Ok(parts.join(", "))
}

/// 値の列(`c0, c1, …`)
pub(crate) fn value_columns(n: usize) -> String {
    (0..n)
        .map(|i| format!("c{i}"))
        .collect::<Vec<_>>()
        .join(", ")
}

/// 検索に一致する列か、の式(`contains(lower(c0), $1) OR …`)
pub(crate) fn search_hits(n: usize, q: &str) -> String {
    (0..n)
        .map(|i| format!("coalesce(contains(lower(c{i}), {q}), false)"))
        .collect::<Vec<_>>()
        .join(", ")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn col(name: &str, ty: CsvType) -> CsvColumn {
        CsvColumn {
            name: name.into(),
            ty,
            decimals: 0,
        }
    }

    #[test]
    fn values_are_parameters_and_names_never_appear() {
        let cols = [
            col("say \"hi\"; --", CsvType::String),
            col("x", CsvType::Float),
        ];
        let mut p = Params::default();
        let w = filters(
            &cols,
            &[
                CsvFilter {
                    col: 0,
                    op: CsvFilterOp::Contains,
                    value: "'; DROP TABLE t; --".into(),
                    value2: String::new(),
                },
                CsvFilter {
                    col: 1,
                    op: CsvFilterOp::Between,
                    value: "1".into(),
                    value2: "2.5".into(),
                },
            ],
            &mut p,
        )
        .unwrap();
        assert_eq!(w, "(contains(lower(c0), $1)) AND (n1 BETWEEN $2 AND $3)");
        assert!(!w.contains("hi") && !w.contains("DROP"));
        assert_eq!(p.0[0], Value::Text("'; drop table t; --".into()));
        assert_eq!(p.0[2], Value::Double(2.5));
        assert_eq!(
            order(
                &cols,
                &[
                    CsvSort { col: 0, desc: true },
                    CsvSort {
                        col: 1,
                        desc: false
                    }
                ]
            )
            .unwrap(),
            "lower(c0) DESC NULLS LAST, n1 ASC NULLS LAST, __row ASC"
        );
    }

    #[test]
    fn rejects_bad_requests() {
        let cols = [col("x", CsvType::Float), col("s", CsvType::String)];
        let bad = |f: CsvFilter| filters(&cols, &[f], &mut Params::default()).is_err();
        assert!(bad(CsvFilter {
            col: 0,
            op: CsvFilterOp::Gt,
            value: "abc".into(),
            value2: String::new()
        }));
        assert!(bad(CsvFilter {
            col: 1,
            op: CsvFilterOp::Gt,
            value: "1".into(),
            value2: String::new()
        }));
        assert!(bad(CsvFilter {
            col: 9,
            op: CsvFilterOp::Empty,
            value: String::new(),
            value2: String::new()
        }));
        assert!(
            order(
                &cols,
                &[CsvSort {
                    col: 5,
                    desc: false
                }]
            )
            .is_err()
        );
    }
}
