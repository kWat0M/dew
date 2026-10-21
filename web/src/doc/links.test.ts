import { describe, expect, test } from 'vitest';
import { classifyImage, classifyLink, normalize, urlTransform } from './links';

const doc = '/w/md/a.md';

describe('リンクの行き先(17.2)', () => {
  test.each([
    ['docs/b.md', { kind: 'markdown', target: '/w/md/docs/b.md', hash: undefined }],
    ['../x.md#節', { kind: 'markdown', target: '/w/x.md', hash: '節' }],
    ['img/pic.png', { kind: 'path', target: '/w/md/img/pic.png', hash: undefined }],
    ['..', { kind: 'path', target: '/w', hash: undefined }],
    ['%E3%81%82.md', { kind: 'markdown', target: '/w/md/あ.md', hash: undefined }],
    ['#%E8%A1%A8', { kind: 'anchor', target: '表' }],
    ['https://example.com/', { kind: 'external', target: 'https://example.com/' }],
    ['mailto:a@example.com', { kind: 'external', target: 'mailto:a@example.com' }],
    ['javascript:alert(1)', { kind: 'none', target: '' }],
    [' JavaScript:alert(1)', { kind: 'none', target: '' }],
    ['data:text/html,x', { kind: 'none', target: '' }],
    ['//evil.example/', { kind: 'none', target: '' }],
  ])('%s', (href, want) => {
    expect(classifyLink(doc, href)).toEqual(want);
  });
});

describe('画像の出し方', () => {
  test('相対・範囲外・外部・data', () => {
    expect(classifyImage(doc, '/w', 'img/pic.png')).toEqual({ kind: 'local', path: '/w/md/img/pic.png' });
    expect(classifyImage(doc, '/w', '../../outside.png')).toEqual({ kind: 'outside', path: '/outside.png' });
    // 名前の前方一致で範囲内と取り違えない
    expect(classifyImage('/w/a.md', '/w', '../wx/a.png')).toEqual({ kind: 'outside', path: '/wx/a.png' });
    expect(classifyImage(doc, '/w', 'https://cdn.example.com/a.png')).toEqual({ kind: 'external', url: 'https://cdn.example.com/a.png', host: 'cdn.example.com' });
    expect(classifyImage(doc, '/w', 'data:image/png;base64,AAAA').kind).toBe('data');
    expect(classifyImage(doc, '/w', 'javascript:x').kind).toBe('none');
  });
});

test('パスの正規化と URL の変換', () => {
  expect(normalize('/a/./b/../c//d')).toBe('/a/c/d');
  expect(normalize('/../a')).toBe('/a');
  expect(urlTransform('javascript:alert(1)', 'href')).toBe('');
  expect(urlTransform('data:image/png;base64,AA', 'src')).toBe('data:image/png;base64,AA');
  expect(urlTransform('data:image/png;base64,AA', 'href')).toBe('');
  expect(urlTransform('docs/b.md', 'href')).toBe('docs/b.md');
});
