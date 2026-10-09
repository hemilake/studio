# Images in the conversation

Studio shows image files from the project inline, as a card next to the visuals of `docs/fork/visuals.md`. The pictures usually come from the `images` skill of the Hemilake plugin (Google's Nano Banana 2 and Nano Banana Pro on the gateway Studio's Claude Code already uses), but any image in the project works: a screenshot the model took, a chart it saved, a photo the owner uploaded. This file is the contract between Studio and that skill.

## What the model writes

A Markdown image with a short title as the alt text and the path relative to the project:

```markdown
![Lemon in watercolour](images/20261009-153750-lemon.png)
```

An absolute path works too while it stays inside the project. The file is fetched through the authenticated files route (`api.readFileBlob`) and shown from a blob URL, since a bare `<img src>` cannot carry the session token.

## The card

- Title: the alt text, else the title, else the file name. The path shows on hover.
- The image at its own size up to the chat's width and 560 px high; a click opens it full screen.
- Toolbar on hover (always visible on touch screens): Ask to change (fills the composer with `Update the "<title>" image (<path>): `, so the model knows which file to edit), Download (the file under its own name), Copy path, Full screen.
- Web (`http(s):`), `data:` and `blob:` images stay a plain thumbnail with the lightbox: they are not the project's, and a badge inside a sentence should not turn into a card.
- Everything is a `<span>`, because react-markdown wraps an image in a `<p>`.

## How the model knows

The last paragraph of `server/shared/studio-visuals-prompt.ts` (appended to Claude Code's system prompt in every Studio session) says Studio draws workspace images this way and points at the `images` skill. The skill itself (`plugin/skills/images` in hemilake/hemisphere) writes the file to `images/` in the project and tells the model to embed it as above.

## Public shares

A shared page renders without the workspace (`disableWorkspace`), so a generated image appears there as `[image]`, like any other workspace file.

## Files

`src/modules/chat/transcript/MarkdownImage.tsx`, `src/modules/i18n/locales/{en,es}/chat.json` (`image.*`), `server/shared/studio-visuals-prompt.ts`.
