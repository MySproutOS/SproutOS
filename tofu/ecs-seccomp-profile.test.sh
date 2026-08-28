#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
profile="$SCRIPT_DIR/ecs-seccomp-profile.json"
expected_base_sha=25497e540002b93d4503da25ab60b7f292def23af8ae6f53da115ef6092e5f67

actual_base_sha="$(jq -cS 'del(.syscalls[-10:])' "$profile" | sha256sum | cut -d' ' -f1)"
[[ "$actual_base_sha" == "$expected_base_sha" ]]
[[ "$(jq -r '.defaultAction' "$profile")" == SCMP_ACT_ERRNO ]]
[[ "$(jq -c '.architectures' "$profile")" == '["SCMP_ARCH_AARCH64","SCMP_ARCH_ARM"]' ]]

# Docker must continue denying these globally. The plugin's sealed inner filter denies them again
# after Bubblewrap setup.
for syscall in unshare setns; do
  [[ "$(jq --arg syscall "$syscall" \
    '[.syscalls[] | select(.action == "SCMP_ACT_ALLOW" and (.names | index($syscall)))] | length' \
    "$profile")" == 0 ]]
done

[[ "$(jq \
  '[.syscalls[] | select(.action == "SCMP_ACT_ALLOW" and .names == ["clone"] and .args == [{"index":0,"op":"SCMP_CMP_EQ","value":2114060305}])] | length' \
  "$profile")" == 1 ]]
[[ "$(jq -c \
  '[.syscalls[] | select(.action == "SCMP_ACT_ALLOW" and .names == ["mount"]) | .args[0].value] | sort' \
  "$profile")" == '[6,53248,311296,573440,2134054,2134055,3236810752]' ]]
[[ "$(jq \
  '[.syscalls[] | select(.action == "SCMP_ACT_ALLOW" and .names == ["pivot_root"] and (.args | not))] | length' \
  "$profile")" == 1 ]]
[[ "$(jq \
  '[.syscalls[] | select(.action == "SCMP_ACT_ALLOW" and .names == ["umount2"] and .args == [{"index":1,"op":"SCMP_CMP_EQ","value":2}])] | length' \
  "$profile")" == 1 ]]

echo 'ECS seccomp profile preserves the captured default and only admits traced bwrap setup calls'
