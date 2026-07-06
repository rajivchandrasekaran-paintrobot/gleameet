# Evolvio — Meeting Coaching Platform

## Architecture
Monorepo with 11 packages. Build order: shared → law-registry → client-core → ui-app → platform-* → backend | extension | teams-app | zoom-app

## Hard Rules
- `packages/client-core` must NEVER import chrome.*, @microsoft/teams-js, or @zoom/appssdk
- `packages/ui-app` must NEVER import any platform-specific API
- All backend route changes must be backward-compatible with the shipping Chrome extension
- Every PR must pass: `npm run build && npm test` from root
- The Chrome extension must install and complete a full Meet session after every backend/shared change

## Package Dependency Graph
shared ← law-registry
shared ← client-core ← platform-chrome ← extension
shared ← client-core ← platform-teams-app ← teams-app
shared ← client-core ← platform-zoom-app ← zoom-app
shared ← client-core ← ui-app ← (extension | teams-app | zoom-app)
shared ← backend

## Subagent Delegation Rules
- Read-only research and analysis: delegate to @explore or @analyzer
- Code extraction/porting: delegate to @extractor
- New module creation: delegate to @implementer
- Test writing: delegate to @test-writer
- Cross-package validation: delegate to @contract-checker
- Never let a write-capable agent touch packages/extension without explicit instruction
