// Minimal XML reader for Simulink .slx parts: elements, attributes, text and CDATA.
// Runs in browsers and in Node (no DOMParser needed).

export interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|\w+);/g, (m, e: string) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENTITIES[e] ?? m;
  });
}

export function parseXml(src: string): XmlNode {
  const root: XmlNode = { name: '#document', attrs: {}, children: [], text: '' };
  const stack = [root];
  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0) break;
    if (lt > i) stack[stack.length - 1].text += decodeEntities(src.slice(i, lt));
    if (src.startsWith('<!--', lt)) { i = end(src, '-->', lt) + 3; continue; }
    if (src.startsWith('<![CDATA[', lt)) {
      const e = end(src, ']]>', lt);
      stack[stack.length - 1].text += src.slice(lt + 9, e);
      i = e + 3;
      continue;
    }
    if (src.startsWith('<?', lt)) { i = end(src, '?>', lt) + 2; continue; }
    if (src.startsWith('<!', lt)) { i = end(src, '>', lt) + 1; continue; }
    const gt = tagEnd(src, lt);
    const body = src.slice(lt + 1, gt);
    i = gt + 1;
    if (body[0] === '/') {
      const name = body.slice(1).trim();
      while (stack.length > 1 && stack.pop()!.name !== name) { /* tolerate unclosed tags */ }
      continue;
    }
    const selfClose = body.endsWith('/');
    const m = /^([^\s/>]+)/.exec(body);
    if (!m) throw new Error('Poškodené XML');
    const node: XmlNode = { name: m[1], attrs: {}, children: [], text: '' };
    const re = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
    let a: RegExpExecArray | null;
    const rest = body.slice(m[1].length);
    while ((a = re.exec(rest))) node.attrs[a[1]] = decodeEntities(a[3] ?? a[4] ?? '');
    stack[stack.length - 1].children.push(node);
    if (!selfClose) stack.push(node);
  }
  return root;
}

function end(src: string, token: string, from: number): number {
  const e = src.indexOf(token, from);
  if (e < 0) throw new Error('Poškodené XML');
  return e;
}

/** Index of the '>' closing the tag at `lt`, skipping quoted attribute values. */
function tagEnd(src: string, lt: number): number {
  let q = '';
  for (let i = lt + 1; i < src.length; i++) {
    const c = src[i];
    if (q) { if (c === q) q = ''; }
    else if (c === '"' || c === "'") q = c;
    else if (c === '>') return i;
  }
  throw new Error('Poškodené XML');
}

export const kids = (n: XmlNode, name: string) => n.children.filter((c) => c.name === name);
export const kid = (n: XmlNode, name: string) => n.children.find((c) => c.name === name);

/** All descendants with the given element name, depth first. */
export function findAll(n: XmlNode, name: string, out: XmlNode[] = []): XmlNode[] {
  for (const c of n.children) {
    if (c.name === name) out.push(c);
    findAll(c, name, out);
  }
  return out;
}
