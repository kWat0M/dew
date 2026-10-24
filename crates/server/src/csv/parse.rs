//! CSV の解析(16.2): 区切り文字・ヘッダーの判定、列数が不揃いな行、型の推定。
//! 小規模モード(全件をブラウザへ)と大規模モード(DuckDB へ流し込む)で同じ解析を使い、両モードの結果をそろえる

use std::io::Read;

use dew_protocol::{CsvColumn, CsvType};

/// 区切り文字を推定するのに読む先頭の大きさ
const SNIFF_BYTES: usize = 64 * 1024;
/// 推定の候補(同点なら前のもの)
const CANDIDATES: [u8; 4] = *b",;\t|";

/// 区切り文字。`.tsv` はタブ、そのほかは先頭 64 KB から推定する
pub(crate) fn sniff_delimiter(head: &[u8], tsv: bool) -> u8 {
    if tsv {
        return b'\t';
    }
    let head = &head[..head.len().min(SNIFF_BYTES)];
    let mut best = (0usize, b',');
    for d in CANDIDATES {
        // 引用符を考えて区切り、いちばん多い列数(2列以上)にそろった行の数で比べる
        let mut counts = std::collections::HashMap::<usize, usize>::new();
        let mut rd = reader(head, d);
        let mut rec = csv::ByteRecord::new();
        let mut lines = 0;
        // 最後の行は途中で切れていることがあるので数えない
        let mut last = None;
        while let Ok(true) = rd.read_byte_record(&mut rec) {
            if let Some(n) = last.replace(rec.len()) {
                *counts.entry(n).or_default() += 1;
            }
            lines += 1;
            if lines > 1000 {
                break;
            }
        }
        if lines == 1
            && let Some(n) = last
        {
            *counts.entry(n).or_default() += 1;
        }
        let score = counts
            .iter()
            .filter(|(n, _)| **n > 1)
            .map(|(_, c)| *c)
            .max()
            .unwrap_or(0);
        if score > best.0 {
            best = (score, d);
        }
    }
    best.1
}

pub(crate) fn reader<R: Read>(r: R, delimiter: u8) -> csv::Reader<R> {
    csv::ReaderBuilder::new()
        .has_headers(false)
        .flexible(true)
        .delimiter(delimiter)
        .double_quote(true)
        .from_reader(r)
}

/// 列ごとの型の候補(16.2 の表)。値を見るたびに合わないものを外す
#[derive(Debug, Clone)]
pub(crate) struct Guess {
    integer: bool,
    float: bool,
    boolean: bool,
    date: bool,
    /// 空でない値があった
    seen: bool,
    decimals: u8,
}

impl Default for Guess {
    fn default() -> Self {
        Guess {
            integer: true,
            float: true,
            boolean: true,
            date: true,
            seen: false,
            decimals: 0,
        }
    }
}

impl Guess {
    pub(crate) fn feed(&mut self, v: &str) {
        if v.is_empty() {
            return;
        }
        self.seen = true;
        if self.integer && !is_integer(v) {
            self.integer = false;
        }
        if self.float {
            match float_decimals(v) {
                Some(d) => self.decimals = self.decimals.max(d),
                None => self.float = false,
            }
        }
        if self.boolean && !(v.eq_ignore_ascii_case("true") || v.eq_ignore_ascii_case("false")) {
            self.boolean = false;
        }
        if self.date && !is_iso_date(v) {
            self.date = false;
        }
    }

    pub(crate) fn ty(&self) -> CsvType {
        match self {
            Guess { seen: false, .. } => CsvType::String,
            Guess { integer: true, .. } => CsvType::Integer,
            Guess { float: true, .. } => CsvType::Float,
            Guess { boolean: true, .. } => CsvType::Boolean,
            Guess { date: true, .. } => CsvType::Date,
            _ => CsvType::String,
        }
    }

    fn decimals(&self) -> u8 {
        if matches!(self.ty(), CsvType::Float) {
            self.decimals
        } else {
            0
        }
    }
}

/// 整数(符号と数字だけ、i64 に収まる)。`1,234` のような桁区切りは文字列
pub(crate) fn is_integer(v: &str) -> bool {
    let digits = v.strip_prefix(['-', '+']).unwrap_or(v);
    !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()) && v.parse::<i64>().is_ok()
}

/// 数値(指数表記を含む)なら、小数の桁数。inf や nan、桁区切りは数値としない
pub(crate) fn float_decimals(v: &str) -> Option<u8> {
    let body = v.strip_prefix(['-', '+']).unwrap_or(v);
    let (mantissa, exp) = match body.find(['e', 'E']) {
        Some(i) => (&body[..i], Some(&body[i + 1..])),
        None => (body, None),
    };
    let (int, frac) = mantissa.split_once('.').unwrap_or((mantissa, ""));
    let digits = |s: &str| s.bytes().all(|b| b.is_ascii_digit());
    if int.is_empty() && frac.is_empty() || !digits(int) || !digits(frac) {
        return None;
    }
    if let Some(e) = exp {
        let e = e.strip_prefix(['-', '+']).unwrap_or(e);
        if e.is_empty() || !digits(e) {
            return None;
        }
    }
    v.parse::<f64>().ok().filter(|f| f.is_finite())?;
    Some(frac.len().min(u8::MAX as usize) as u8)
}

/// ISO 8601 の日付・日時(`2026-10-21`、`2026-10-21T12:00`、`2026-10-21 12:00:00.5+09:00` など)
pub(crate) fn is_iso_date(v: &str) -> bool {
    let b = v.as_bytes();
    let num = |s: &[u8]| !s.is_empty() && s.iter().all(u8::is_ascii_digit);
    if b.len() < 10
        || !num(&b[0..4])
        || b[4] != b'-'
        || !num(&b[5..7])
        || b[7] != b'-'
        || !num(&b[8..10])
    {
        return false;
    }
    let (m, d) = (two(&b[5..7]), two(&b[8..10]));
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return false;
    }
    let rest = &b[10..];
    if rest.is_empty() {
        return true;
    }
    if !matches!(rest[0], b'T' | b' ') || rest.len() < 6 {
        return false;
    }
    let t = &rest[1..];
    if !num(&t[0..2]) || t[2] != b':' || !num(&t[3..5]) || two(&t[0..2]) > 23 || two(&t[3..5]) > 59
    {
        return false;
    }
    let mut t = &t[5..];
    if t.len() >= 3 && t[0] == b':' {
        if !num(&t[1..3]) || two(&t[1..3]) > 60 {
            return false;
        }
        t = &t[3..];
        if t.first() == Some(&b'.') {
            let n = t[1..].iter().take_while(|c| c.is_ascii_digit()).count();
            if n == 0 {
                return false;
            }
            t = &t[1 + n..];
        }
    }
    match t {
        [] | [b'Z'] => true,
        [b'+' | b'-', h1, h2, b':', m1, m2] => [h1, h2, m1, m2].iter().all(|c| c.is_ascii_digit()),
        [b'+' | b'-', h1, h2, m1, m2] => [h1, h2, m1, m2].iter().all(|c| c.is_ascii_digit()),
        _ => false,
    }
}

fn two(s: &[u8]) -> u32 {
    u32::from(s[0] - b'0') * 10 + u32::from(s[1] - b'0')
}

/// 1行目の値がすべて数値なら、ヘッダーなしとみなす(16.2)
pub(crate) fn looks_like_header(first: &[String]) -> bool {
    !first
        .iter()
        .all(|v| !v.is_empty() && float_decimals(v).is_some())
}

/// 解析の途中経過(1行ずつ渡す)。列数・不揃いな行・型を数える
#[derive(Debug, Default)]
pub(crate) struct Shape {
    /// ヘッダー行の値(ヘッダーなしなら空)
    pub header: Vec<String>,
    pub guesses: Vec<Guess>,
    pub rows: u64,
    pub ragged: u64,
    /// ヘッダーの列数(ヘッダーなしなら最初の行の列数)
    width: Option<usize>,
}

impl Shape {
    pub(crate) fn new(header: Option<Vec<String>>) -> Self {
        let width = header.as_ref().map(Vec::len);
        Shape {
            header: header.unwrap_or_default(),
            width,
            ..Default::default()
        }
    }

    pub(crate) fn feed<'a>(&mut self, n: usize, fields: impl Iterator<Item = &'a str>) {
        let width = *self.width.get_or_insert(n);
        if n != width {
            self.ragged += 1;
        }
        if self.guesses.len() < n {
            self.guesses.resize_with(n, Guess::default);
        }
        for (g, v) in self.guesses.iter_mut().zip(fields) {
            g.feed(v);
        }
        self.rows += 1;
    }

    /// 列。名前のない列・ヘッダーより多い列は「列N」
    pub(crate) fn columns(&self) -> Vec<CsvColumn> {
        let n = self.guesses.len().max(self.header.len());
        (0..n)
            .map(|i| {
                let name = self.header.get(i).filter(|s| !s.is_empty()).cloned();
                let g = self.guesses.get(i).cloned().unwrap_or_default();
                CsvColumn {
                    name: name.unwrap_or_else(|| format!("列{}", i + 1)),
                    ty: g.ty(),
                    decimals: g.decimals(),
                }
            })
            .collect()
    }
}

/// 全件を解析した表(小規模モード)。値は列ごと、空のセルは None
#[derive(Debug)]
pub(crate) struct Table {
    pub columns: Vec<CsvColumn>,
    pub cells: Vec<Vec<Option<String>>>,
    pub rows: u64,
    pub ragged: u64,
    pub header: bool,
}

/// UTF-8 の文字列を全件解析する。header が None なら1行目を見て決める
pub(crate) fn parse(text: &str, delimiter: u8, header: Option<bool>) -> Table {
    let mut rd = reader(text.as_bytes(), delimiter);
    let mut records = rd.records().filter_map(Result::ok);
    let first: Option<Vec<String>> = records
        .next()
        .map(|r| r.iter().map(str::to_owned).collect());
    let has_header = header.unwrap_or_else(|| first.as_deref().is_some_and(looks_like_header));
    let mut shape;
    let mut rows: Vec<Vec<String>> = Vec::new();
    if has_header {
        shape = Shape::new(first);
    } else {
        shape = Shape::new(None);
        if let Some(f) = first {
            shape.feed(f.len(), f.iter().map(String::as_str));
            rows.push(f);
        }
    }
    for r in records {
        shape.feed(r.len(), r.iter());
        rows.push(r.iter().map(str::to_owned).collect());
    }
    let columns = shape.columns();
    let mut cells: Vec<Vec<Option<String>>> = vec![Vec::with_capacity(rows.len()); columns.len()];
    for row in rows {
        let mut it = row.into_iter();
        for col in cells.iter_mut() {
            col.push(it.next().filter(|v| !v.is_empty()));
        }
    }
    Table {
        columns,
        cells,
        rows: shape.rows,
        ragged: shape.ragged,
        header: has_header,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sniffs_delimiters() {
        assert_eq!(sniff_delimiter(b"a,b,c\n1,2,3\n", false), b',');
        assert_eq!(sniff_delimiter(b"a;b;c\n1;2,5;3\n4;5;6\n", false), b';');
        assert_eq!(sniff_delimiter(b"a\tb\n1\t2\n", false), b'\t');
        assert_eq!(sniff_delimiter(b"a|b\n1|2\n", false), b'|');
        // 引用符の中のカンマは数えない
        assert_eq!(
            sniff_delimiter(b"a;b\n\"x,y,z\";1\n\"p,q,r\";2\n", false),
            b';'
        );
        assert_eq!(sniff_delimiter(b"a,b\n", true), b'\t');
        assert_eq!(sniff_delimiter(b"single\n", false), b',');
    }

    #[test]
    fn infers_types() {
        let ty = |vals: &[&str]| {
            let mut g = Guess::default();
            for v in vals {
                g.feed(v);
            }
            (g.ty(), g.decimals())
        };
        assert_eq!(ty(&["1", "-2", "", "+30"]), (CsvType::Integer, 0));
        assert_eq!(ty(&["1", "2.50", "1e3", "-.5"]), (CsvType::Float, 2));
        assert_eq!(ty(&["true", "FALSE", ""]), (CsvType::Boolean, 0));
        assert_eq!(
            ty(&[
                "2026-10-21",
                "2026-10-21T12:00:00",
                "2026-01-02 03:04+09:00"
            ]),
            (CsvType::Date, 0)
        );
        assert_eq!(ty(&["1,234"]), (CsvType::String, 0));
        assert_eq!(ty(&["inf", "nan"]), (CsvType::String, 0));
        assert_eq!(ty(&["2026-13-01"]), (CsvType::String, 0));
        assert_eq!(ty(&["", ""]), (CsvType::String, 0));
        assert_eq!(ty(&["99999999999999999999"]), (CsvType::Float, 0));
    }

    #[test]
    fn parses_quotes_header_and_ragged_rows() {
        let t = parse(
            "key,text\na,\"1行目\n2行目\"\nb,\"カンマ, を含む\"\nc,\"引用符 \"\"です\"\"\"\n",
            b',',
            None,
        );
        assert!(t.header);
        assert_eq!(t.rows, 3);
        assert_eq!(t.cells[1][0].as_deref(), Some("1行目\n2行目"));
        assert_eq!(t.cells[1][2].as_deref(), Some("引用符 \"です\""));
        let t = parse(
            "a,b,c\n1,2,3\n4,5\n6,7,8,9\n10,11,12,13,14\n15,16,17\n",
            b',',
            None,
        );
        assert_eq!(t.ragged, 3);
        let names: Vec<_> = t.columns.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, ["a", "b", "c", "列4", "列5"]);
        assert_eq!(t.cells[2][1], None);
        assert_eq!(t.cells[4][3].as_deref(), Some("14"));
        // 1行目が数値ならヘッダーなし
        let t = parse("1,2\n3,4\n", b',', None);
        assert!(!t.header);
        assert_eq!(t.rows, 2);
        assert_eq!(t.columns[0].name, "列1");
        assert_eq!(t.columns[0].ty, CsvType::Integer);
        // 手で指定したら従う
        assert!(parse("1,2\n3,4\n", b',', Some(true)).header);
    }
}
