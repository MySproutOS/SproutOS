#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
profile="$SCRIPT_DIR/ecs-seccomp-profile.json"
expected_base_sha=25497e540002b93d4503da25ab60b7f292def23af8ae6f53da115ef6092e5f67

fail() {
  echo "$1" >&2
  exit 1
}
assert_equal() {
  local actual="$1"
  local expected="$2"
  local description="$3"
  if [[ "$actual" != "$expected" ]]; then
    fail "$description: expected $expected, found $actual"
  fi
}

# Command substitution strips jq's one trailing newline. The recorded digest is over canonical
# compact JSON bytes, not over a line-oriented rendering of those bytes.
canonical_base="$(jq -cS 'del(.syscalls[-10:])' "$profile")"
actual_base_sha="$(printf '%s' "$canonical_base" | sha256sum | cut -d' ' -f1)"
assert_equal "$actual_base_sha" "$expected_base_sha" 'captured Docker profile digest changed'
assert_equal "$(jq -r '.defaultAction' "$profile")" SCMP_ACT_ERRNO 'default action changed'
assert_equal \
  "$(jq -c '.architectures' "$profile")" \
  '["SCMP_ARCH_AARCH64","SCMP_ARCH_ARM"]' \
  'profile architectures changed'

# Docker must continue denying these globally. The plugin's sealed inner filter denies them again
# after Bubblewrap setup.
for syscall in unshare setns; do
  assert_equal "$(jq --arg syscall "$syscall" \
    '[.syscalls[] | select(.action == "SCMP_ACT_ALLOW" and (.names | index($syscall)))] | length' \
    "$profile")" 0 "$syscall became globally allowed"
done

assert_equal "$(jq \
  '[.syscalls[] | select(.action == "SCMP_ACT_ALLOW" and .names == ["clone"] and .args == [{"index":0,"op":"SCMP_CMP_EQ","value":2114060305}])] | length' \
  "$profile")" 1 'argument-scoped Bubblewrap clone rule changed'
assert_equal "$(jq -c \
  '[.syscalls[] | select(.action == "SCMP_ACT_ALLOW" and .names == ["mount"]) | .args[0].value] | sort' \
  "$profile")" '[6,53248,311296,573440,2134054,2134055,3236810752]' \
  'argument-scoped Bubblewrap mount rules changed'
assert_equal "$(jq \
  '[.syscalls[] | select(.action == "SCMP_ACT_ALLOW" and .names == ["pivot_root"] and (.args | not))] | length' \
  "$profile")" 1 'Bubblewrap pivot_root rule changed'
assert_equal "$(jq \
  '[.syscalls[] | select(.action == "SCMP_ACT_ALLOW" and .names == ["umount2"] and .args == [{"index":1,"op":"SCMP_CMP_EQ","value":2}])] | length' \
  "$profile")" 1 'argument-scoped Bubblewrap umount2 rule changed'

echo 'ECS seccomp profile preserves the captured default and only admits traced bwrap setup calls'
