package pam.policy

default allow = false

# Input contract:
# {
#   "user": {"subject":"alice","roles":["ops-admin"],"mfa_verified":true},
#   "request": {
#     "target":"prod-db-01",
#     "ticket_id":"INC-3421",
#     "requested_at":"2026-08-16T09:00:00Z",
#     "duration_minutes":60
#   },
#   "context": {
#     "device_trust":"high",
#     "source_ip":"203.0.113.18",
#     "network_allowed":["10.0.0.0/8","172.16.0.0/12"],
#     "approved_ticket_window":{"start":"2026-08-16T08:00:00Z","end":"2026-08-16T10:00:00Z"}
#   },
#   "policy": {
#     "required_roles":["ops-admin","db-admin"],
#     "require_mfa": true,
#     "require_ticket": true,
#     "max_duration_minutes": 60
#   }
# }

# Helper: parse RFC3339 timestamps.
time_in_window(ts, start, end) {
  ts >= start
  ts <= end
}

# Helper: network allowlist check.
ip_in_allowed_network(ip, cidr) {
  net.cidr_contains(cidr, ip)
}

# Deny reason helper.
deny_reason(reason) = reason

allow {
  # MFA is mandatory.
  input.user.mfa_verified == true

  # Role requirement.
  some role in input.user.roles
  role == input.policy.required_roles[_]

  # Ticket validation.
  input.request.ticket_id != ""
  input.request.ticket_id == input.policy.ticket_id

  # Time window validation.
  time_in_window(
    input.request.requested_at,
    input.context.approved_ticket_window.start,
    input.context.approved_ticket_window.end
  )

  # Session duration must be within policy cap.
  input.request.duration_minutes <= input.policy.max_duration_minutes

  # Device trust must be sufficient.
  input.context.device_trust in {"high", "medium"}
  input.policy.minimum_device_trust == input.context.device_trust
    or input.policy.minimum_device_trust == "low"

  # Network context must be from allowed ranges.
  some cidr in input.context.network_allowed
  ip_in_allowed_network(input.context.source_ip, cidr)

  # Strong guard: break-glass or risky requests require additional approval.
  not input.request.risky_action
}

# Decision output includes explicit reasons for API callers.
decision = {
  "allow": allow,
  "reason": reason
} {
  allow
  reason := "approved"
} {
  not allow
  reason := "denied"
}