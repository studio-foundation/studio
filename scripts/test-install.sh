#!/bin/sh
# Runs install.sh against stubbed uname, ldd and curl, and asserts which release asset
# it downloads for a CPU with and without AVX2.
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

mkdir "$work/bin"
cat > "$work/bin/uname" <<'STUB'
#!/bin/sh
case "$1" in -s) echo Linux ;; -m) echo x86_64 ;; esac
STUB
cat > "$work/bin/ldd" <<STUB
#!/bin/sh
echo "\${STUB_LIBC:-ldd (GNU libc) 2.40}"
STUB
# Serves every asset as the same bytes, listed under the requested name in SHA256SUMS.
cat > "$work/bin/curl" <<STUB
#!/bin/sh
out=""; url=""
while [ \$# -gt 0 ]; do
  case "\$1" in -o) out=\$2; shift ;; -*) ;; *) url=\$1 ;; esac
  shift
done
case "\$url" in
  */SHA256SUMS) echo "\$(printf binary | sha256sum | cut -d' ' -f1)  \$(cat "$work/asset")" > "\$out" ;;
  *) echo "\${url##*/}" > "$work/asset"; printf binary > "\$out" ;;
esac
STUB
chmod +x "$work/bin/"*

printf 'flags\t\t: fpu sse4_2 avx avx2 bmi2\n' > "$work/avx2"
printf 'flags\t\t: fpu sse4_2 avx\n' > "$work/no-avx2"

fails=0
expect() { # <cpuinfo> <expected asset or "fail"> [libc banner]
  rm -f "$work/asset"
  if STUB_LIBC="${3:-}" PATH="$work/bin:$PATH" STUDIO_CPUINFO="$work/$1" STUDIO_VERSION=v0.0.0 \
    STUDIO_INSTALL_DIR="$work/install" sh "$root/install.sh" > "$work/log" 2>&1; then
    got=$(cat "$work/asset")
  else
    got=fail
  fi
  if [ "$got" = "$2" ]; then
    echo "ok    $1${3:+ ($3)} -> $2"
  else
    echo "FAIL  $1${3:+ ($3)}: expected $2, got $got"; cat "$work/log"; fails=1
  fi
}

expect avx2 studio-linux-x64
expect no-avx2 studio-linux-x64-baseline
expect avx2 studio-linux-x64-musl "musl libc (x86_64)"
expect no-avx2 fail "musl libc (x86_64)"
exit $fails
