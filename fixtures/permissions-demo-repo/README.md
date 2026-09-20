# Permission demo fixture

This is a disposable example project with no real credentials or infrastructure.
Grant `/workspace` read access and grant only `/workspace/src` and
`/workspace/tests` read/write access. Allow `api.openai.com` for the network probe
and `auth.openai.com` plus `chatgpt.com` for account login. Grant only the dummy
`PERISCOPE_DEMO_GRANTED` environment-variable name; no API key is required.

`infra/prod.tf` and `package.json` should be readable but not writable.
Unlisted project files remain readable: the current mounts do not enforce read
allowlists. See `docs/permissions-demo.md` in the parent Periscope repository.
