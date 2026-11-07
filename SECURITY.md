# Security policy

The Slurm Job Monitor plugin runs inside Grafana with database credentials
for slurmdbd and shows job metadata to Grafana users according to per-cluster
access rules. Issues that let a Grafana user see jobs of a cluster they are
not allowed to access, read or extract the stored database credentials, run
SQL of their choice, or disrupt the plugin backend with crafted requests or
job data are treated as vulnerabilities. So are weaknesses in the optional
MetricSifter sidecar's request handling.

Out of scope: the Docker Compose development stack and its default
credentials (`admin/admin`, `slurm/slurm`), and the security of Grafana,
slurmdbd or Prometheus themselves (please report those upstream).

## Supported versions

Security fixes are made on the `main` branch and released in the next
version. Only the latest release is supported.

## Reporting a vulnerability

Please do **not** open a public issue, pull request or discussion.

Report the vulnerability privately with GitHub's
[private vulnerability reporting](https://github.com/yuuki/grafana-slurm-app/security/advisories/new)
(the "Report a vulnerability" button of the Security tab). If that is not
possible, contact the author privately via the contact information on
https://github.com/yuuki.

Please include the plugin version, the Grafana version, the relevant plugin
configuration (with secrets removed), the request or data an attacker
controls (a Grafana role, query parameters, job names or node lists in
slurmdbd, ...), and the impact. You should receive an answer within a few
weeks; the plugin is maintained on a best-effort basis.
