# Contributing to Stitch

## Branching

`main` is protected — direct pushes are blocked. All changes go through a pull request.

1. Fork the repo (external contributors) or create a branch (collaborators):
   ```bash
   git checkout -b feature/your-feature-name
   # or: fix/short-description | docs/what-changed
   ```
2. Make your changes and commit with a clear message.
3. Push your branch and open a pull request against `main`.
4. A maintainer will review and merge.

## Branch naming

| Prefix | Use for |
|--------|---------|
| `feature/` | New tools or capabilities |
| `fix/` | Bug fixes |
| `docs/` | Documentation only |
| `chore/` | Deps, build, config |

## Development setup

```powershell
git clone https://github.com/damola-m/stitch.git
cd stitch/stitch
npm install
npm run build
```

Copy `.env.example` to `.env` and add your Gemini API key:
```powershell
cp stitch/.env.example stitch/.env
# Edit .env and set GEMINI_API_KEY=your-key
```

Get a free key at <https://aistudio.google.com/api-keys>.

## Code style

- TypeScript — keep it typed, avoid `any`
- Follow the existing annotation style (`// ========= Part N — Description =========`)
- British English in prose and tool/parameter names
- Rebuild before testing: `npm run build`

## What not to commit

- `.env` files or any file containing API keys
- `stitch/build/` — compiled output, generated on install
- `node_modules/`
