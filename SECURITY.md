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

Until the first stable release, only the latest commit and latest prerelease are supported. Teams is a private beta; do not use it to transmit production credentials or other high-impact secrets.

## Security boundaries

- The local daemon accepts only authenticated local IPC requests.
- Agent-provided text is untrusted data and is never executed by Pinboard.
- Provider hooks are capability-detected and require user trust.
- Teams requires an explicit WorkOS-backed device login and repository link. Device credentials are stored in the operating system credential store and never in exported configuration.
- No E2E encryption, enterprise compliance, or wake/resume claim should be inferred from roadmap entries.
