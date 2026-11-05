# octocov reports

Data-only branch. It holds the reports that [octocov](https://github.com/k1LoW/octocov)
stores from the `Complexity` workflow (`.github/workflows/complexity.yml` on
`main`, configured by `.octocov.complexity.yml`), under `complexity-reports/`.
Its commit history is the complexity trend: each push to `main` adds one
report commit.

Do not merge this branch into `main`, and do not delete it: octocov pushes onto
this existing branch and fails when it is missing.
