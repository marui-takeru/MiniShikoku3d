# Claude Code 向けメモ

## Git の運用

- 作業ブランチで変更をコミット・プッシュしたら、**続けて `main` にもマージしてプッシュする**（リポジトリ所有者の指示）。
  - `git fetch origin main` → `main` に作業ブランチをマージ（可能ならfast-forward）→ `git push origin main`
  - 競合したときは解消してから `main` にプッシュし、何をどう解消したかを報告する。
- プルリクエストは、頼まれない限り作らない。
