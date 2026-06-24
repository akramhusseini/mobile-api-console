# Public Release Checklist

Use this checklist before publishing a public GitHub repository.

## Required Before Publishing

- Confirm the current branch does not contain company names, private hostnames,
  real customer data, access tokens, local databases, or log files.
- Confirm the selected license is correct for the project before publishing.
- Publish only the clean `main` branch, not any old local branches that may
  contain earlier private examples.
- Add the remote for the new public repository.
- Push one selected branch explicitly, for example:

```sh
git push -u origin main
```

- Review the repository page after pushing to confirm only the expected files
  are visible.

## Checks Run For This Release

- `npm test`
- `npm audit --omit=dev`
- secret-pattern scan across the working tree
- company/internal identifier scan across the working tree
- package dry run with `npm pack --dry-run`

## Optional Before Wider Sharing

- Add screenshots or a short demo GIF.
- Add GitHub issue templates.
- Add `CONTRIBUTING.md` if outside contributions are expected.
- Add `SECURITY.md` if vulnerability reports should go to a specific channel.
