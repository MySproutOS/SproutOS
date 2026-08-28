#!/usr/bin/env bash

normalize_acme_application_policy() {
  jq -Sc '
    def sorted_array:
      (if type == "array" then . else [.] end) | sort;
    def normalize_tree:
      if type == "object" then
        to_entries | sort_by(.key) | map(.value |= normalize_tree) | from_entries
      elif type == "array" then map(normalize_tree) | sort_by(tojson)
      else .
      end;
    if .Version != "2012-10-17" or (.Statement | type) != "array" then error("invalid policy")
    else {
      Version: .Version,
      Statement: ([.Statement[] |
        if
          (.Effect == "Allow") and has("Action") and has("Resource") and
          ((keys - ["Action", "Condition", "Effect", "Resource", "Sid"]) | length) == 0
        then {
          Effect: .Effect,
          Action: (.Action | sorted_array),
          Resource: (.Resource | sorted_array),
          Condition: ((.Condition // {}) | normalize_tree)
        }
        else error("unsupported or overbroad statement")
        end
      ] | sort_by(tojson))
    } end
  '
}

verify_acme_application_policy() {
  local application_policy reviewed_policy policy_meta policy_version policy_document
  local reviewed_normalized live_normalized
  application_policy=$(tofu -chdir="$TOFU_DIR" output -raw application_policy_arn)
  reviewed_policy=$(tofu -chdir="$TOFU_DIR" output -raw application_policy_document)
  policy_meta=$(aws iam get-policy --policy-arn "$application_policy" --output json)
  policy_version=$(jq -r '.Policy.DefaultVersionId' <<<"$policy_meta")
  policy_document=$(aws iam get-policy-version --policy-arn "$application_policy" \
    --version-id "$policy_version" --output json)
  if ! reviewed_normalized=$(normalize_acme_application_policy <<<"$reviewed_policy"); then
    echo "reviewed OpenTofu application policy cannot be normalized safely" >&2
    return 1
  fi
  if ! live_normalized=$(jq -c '.PolicyVersion.Document' <<<"$policy_document" | normalize_acme_application_policy); then
    echo "live application policy contains unsupported Deny, wildcard, or alternate grant semantics" >&2
    return 1
  fi
  if [ "$live_normalized" != "$reviewed_normalized" ]; then
    echo "live application policy is not semantically identical to the reviewed OpenTofu policy" >&2
    return 1
  fi
}
