import { expect, test } from "bun:test";
import { ChatGptMarkdownBuffer, chatGptHtmlToMarkdown } from "../src/adapters/chatgpt-web/markdown";

// Reduced from the live ChatGPT renderer's table and code-block response.
const table = '<table><tbody><tr><th><p><span>#</span></p></th><th><p>Item</p></th><th><p>Value</p></th></tr><tr><td><p><span>1</span></p></td><td><p>first</p></td><td><p><span>7</span></p></td></tr><tr><td><p>2</p></td><td><p>second</p></td><td><p>9</p></td></tr></tbody></table>';
const codeBlock = (code: string, label = "Plain text") => `<div data-code-block="true"><div data-markdown-copy="exclude"><div>${label}</div><div><button>Copy code</button></div></div><div data-code-block-source="true"><code><span>${code}</span></code></div></div>`;

test("current ChatGPT tables preserve numeric cells and stay on one line per row", () => {
  expect(chatGptHtmlToMarkdown(table)).toBe("| # | Item | Value |\n| --- | --- | --- |\n| 1 | first | 7 |\n| 2 | second | 9 |");
  expect(chatGptHtmlToMarkdown('<table><tr><th>Value</th></tr><tr><td><p><strong>a|b</strong></p><p>next</p></td></tr></table>'))
    .toBe("| Value |\n| --- |\n| **a\\|b**<br>next |");
});

test("current ChatGPT code sources retain newlines, indentation and blank lines", () => {
  expect(chatGptHtmlToMarkdown(codeBlock('<span>CONTEXT_ONE</span>\n<span>  CONTEXT_TWO</span>\n\n\n<span>42</span>')))
    .toBe("```text\nCONTEXT_ONE\n  CONTEXT_TWO\n\n\n42\n```");
  expect(chatGptHtmlToMarkdown(codeBlock('print("ok")\n', "Python")))
    .toBe('```python\nprint("ok")\n```');
});

test("code containing fences round-trips without truncation and legacy PRE still works", () => {
  expect(chatGptHtmlToMarkdown(codeBlock('```\n42\n```'))).toBe("````text\n```\n42\n```\n````");
  expect(chatGptHtmlToMarkdown('<pre><code class="language-bash">echo ONE\n  echo TWO\n</code></pre>'))
    .toBe("```bash\necho ONE\n  echo TWO\n```");
});

test("numeric answers are content while identified map widgets remain excluded", () => {
  expect(chatGptHtmlToMarkdown("<p><span>42</span></p>")).toBe("42");
  expect(chatGptHtmlToMarkdown('<div data-testid="map-widget"><p>9</p></div><p>42</p>')).toBe("42");
});

test("maps and carousels keep useful semantic places and links without controls", () => {
  const html = '<div data-testid="map-widget"><button>Zoom in</button><span>Mapbox</span>'
    + '<div data-testid="place-card"><h3>Central Library</h3><a href="https://example.org/library">Visit library</a></div>'
    + '<div data-testid="place-card"><h3>City Museum</h3></div></div>';
  const converted = chatGptHtmlToMarkdown(html);
  expect(converted).toContain("Central Library");
  expect(converted).toContain("City Museum");
  expect(converted).toContain("[Visit library](https://example.org/library)");
  expect(converted).not.toContain("Zoom in");
  expect(converted).not.toContain("Mapbox");
  expect(chatGptHtmlToMarkdown('<div data-testid="map-widget"><button>Zoom in</button></div>')).toBe("");
});

test("image references remain in Markdown without embedding browser-only bytes", () => {
  expect(chatGptHtmlToMarkdown('<p>Diagram <img alt="Architecture diagram" src="https://example.org/diagram.png" /></p>'))
    .toContain('![Architecture diagram](https://example.org/diagram.png)');
  expect(chatGptHtmlToMarkdown('<p><img alt="Generated chart" src="blob:https://chatgpt.com/123" /></p>'))
    .toContain('[Image: Generated chart]');
  expect(chatGptHtmlToMarkdown('<p><img alt="Screenshot" src="data:image/png;base64,AAAAAAAA" /></p>'))
    .not.toContain('base64');
});

test("code wrappers without the modern source element fall back without crashing", () => {
  expect(chatGptHtmlToMarkdown('<div data-code-block="true"><pre><code class="language-text">ONE\nTWO</code></pre></div>'))
    .toBe("```text\nONE\nTWO\n```");
  expect(chatGptHtmlToMarkdown('<div data-code-block="true"><code>ONE</code></div>')).toContain("ONE");
});

test("append-only response buffering preserves complete modern tables and code blocks", () => {
  const buffer = new ChatGptMarkdownBuffer();
  buffer.observe([{ key: "answer", html: table + codeBlock("ONE\nTWO"), text: "answer", streamable: false }]);
  const result = buffer.finish();
  expect(result.markdown).toContain("| 1 | first | 7 |");
  expect(result.markdown).toContain("```text\nONE\nTWO\n```");
  expect(result.delta).toBe(result.markdown);
});
