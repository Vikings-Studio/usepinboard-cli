# Security Policy

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability.

Use GitHub private vulnerability reporting for this repository. If that is unavailable, email `teamvikingstech@gmail.com` with the subject `Pinboard CLI security report`.

Include:

- affected version or commit;
- operating system and provider version;
- impact and realistic attack path;
- minimal reproduction without real secrets or customer data;
- suggested mitigation, if known.

We will acknowledge reports as soon as practical, coordinate remediation and disclosure, and credit reporters who request it.

## Supported versions

Until the first stable release, only the latest commit and latest prerelease are supported. This repository is pre-alpha and must not be treated as a security boundary for production secrets.

## Security boundaries

- The local daemon accepts only authenticated local IPC requests.
- Agent-provided text is untrusted data and is never executed by Pinboard.
- Provider hooks are capability-detected and require user trust.
- Teams/cloud functionality is not implemented in this repository yet.
- No E2E encryption, enterprise compliance, or wake/resume claim should be inferred from roadmap entries.
