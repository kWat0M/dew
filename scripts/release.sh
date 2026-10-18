#!/bin/bash
# 配布用のバイナリを作る(spec 7.10)。画面(web)を作り直してから、musl の静的リンクでビルドし、
# dist/dew-<版>-<コミット>-x86_64-linux/ に dew・README.md・LICENSE・SHA256SUMS を置いて、同じ名前の tar.gz にまとめる
#   scripts/release.sh
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "release: コミットしていない変更があります。どの版か分からなくなるので、コミットしてから作ってください" >&2
  exit 1
fi

pnpm -C web build
cargo build --release --target x86_64-unknown-linux-musl
bin=target/x86_64-unknown-linux-musl/release/dew

# 静的リンクになっているか(どの Linux でも動くように)
if ! file "$bin" | grep -q "static"; then
  echo "release: $bin が静的リンクになっていません" >&2
  file "$bin" >&2
  exit 1
fi

version=$("$bin" --version)            # 例: dew 0.1.0 (05f218c, 2026-10-18)
semver=$(echo "$version" | awk '{print $2}')
commit=$(echo "$version" | sed -E 's/.*\(([0-9a-f]+),.*/\1/')
name="dew-$semver-$commit-x86_64-linux"
out="dist/$name"
rm -rf "$out" "dist/$name.tar.gz"
mkdir -p "$out"
cp "$bin" "$out/dew"
cp README.md LICENSE "$out/"
(cd "$out" && sha256sum dew > SHA256SUMS)
tar -C dist -czf "dist/$name.tar.gz" "$name"

echo "release: $version"
echo "release: dist/$name.tar.gz($(du -h "dist/$name.tar.gz" | cut -f1))"
