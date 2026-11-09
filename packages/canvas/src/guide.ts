/** The guide the `canvas` tool returns for `guide`. Read once before building the first frame. */
export const GUIDE = `# Building frames for the canvas

A frame is one version of a design: a folder of static files that runs with no server and no network. The canvas shows frames side by side; the person compares them, uses them and comments on them.

## What a frame can do

- Load its own files: HTML, scripts, styles, images, fonts, JSON. Use relative paths.
- Keep state in localStorage. Each frame has its own origin, so frames never share storage.
- Nothing else. The browser blocks requests to any other address, form posts to a server, and embedding elsewhere. A frame that needs an API will not work: replace the API with mock data in the folder.

## Building one

- Plain HTML: write index.html (and its files) into a folder of its own.
- A Vite project: build with a relative base, e.g. \`vite build --base ./ --outDir <folder>\`.
- Several versions from one build: read the version from the query string and pass \`entry\`, e.g. \`index.html?variant=compact\`.
- Keep work folders outside the source you are designing, e.g. a scratch folder, so the project stays clean.

## Content

- Use invented, realistic data. Never real people's names, emails or records, and never secrets, keys or .env files (they are refused).
- Use the design's real size: 390×844 for a phone, 1280×800 for a desktop page.
- Remove analytics, tag managers and chat widgets.

## Working on the canvas

1. \`add\` each version with a short, specific title, its folder, width and height. Add a set in one call with \`frames\` so it is placed together; use \`newRow\` to start a new row for a new direction.
2. Look at the screenshot in the result. Check it shows what you meant: styles applied, right screen, right state. Say what you did not check.
3. To change a version, \`update\` it (with the hash from add or list). Do not remove and re-add: that loses its comments.
4. Comments from the person arrive in your context when they change. Positions are in the frame's own pixels.
5. If a change is refused because the frame changed since you read it, \`list\` and decide; never retry blindly. Change only frames you added unless the person asks.
6. \`show\` only when the person asks to see something.
`;
