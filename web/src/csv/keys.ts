// CSV のウィンドウのキー(16.7)と、操作パネルに出す操作。表の描画(CsvView)とは別にして、最初のチャンクに入れる
import type { CommandDef } from '../commands';
import { ja } from '../i18n/ja';

export type CsvAction =
  | { do: 'move'; dr: number; dc: number }
  | { do: 'page'; dir: 1 | -1; half?: boolean }
  | { do: 'pageSide'; dir: 1 | -1 }
  | { do: 'top' } | { do: 'bottom' } | { do: 'home' } | { do: 'end' }
  | { do: 'jump' } | { do: 'inspect' } | { do: 'search' } | { do: 'match'; dir: 1 | -1 }
  | { do: 'sort'; add: boolean } | { do: 'filter' } | { do: 'clearFilters' } | { do: 'rename' }
  | { do: 'decimals'; dir: 1 | -1 } | { do: 'mark' } | { do: 'rules' } | { do: 'hide' } | { do: 'showAll' }
  | { do: 'pin' } | { do: 'width'; f: number } | { do: 'fit' } | { do: 'copy'; row: boolean } | { do: 'settings' } | { do: 'reset' } | { do: 'exit' };

/** 入力モードのキー(16.7) */
export const csvKeys: Record<string, CsvAction> = {
  h: { do: 'move', dr: 0, dc: -1 }, l: { do: 'move', dr: 0, dc: 1 }, j: { do: 'move', dr: 1, dc: 0 }, k: { do: 'move', dr: -1, dc: 0 },
  ArrowLeft: { do: 'move', dr: 0, dc: -1 }, ArrowRight: { do: 'move', dr: 0, dc: 1 }, ArrowDown: { do: 'move', dr: 1, dc: 0 }, ArrowUp: { do: 'move', dr: -1, dc: 0 },
  J: { do: 'page', dir: 1 }, K: { do: 'page', dir: -1 }, d: { do: 'page', dir: 1, half: true }, u: { do: 'page', dir: -1, half: true },
  H: { do: 'pageSide', dir: -1 }, L: { do: 'pageSide', dir: 1 },
  'g g': { do: 'top' }, G: { do: 'bottom' }, '0': { do: 'home' }, $: { do: 'end' },
  ':': { do: 'jump' }, Enter: { do: 'inspect' }, '/': { do: 'search' }, n: { do: 'match', dir: 1 }, N: { do: 'match', dir: -1 },
  s: { do: 'sort', add: false }, S: { do: 'sort', add: true }, f: { do: 'filter' }, F: { do: 'clearFilters' }, r: { do: 'rename' },
  '+': { do: 'decimals', dir: 1 }, '-': { do: 'decimals', dir: -1 }, m: { do: 'mark' }, M: { do: 'rules' },
  x: { do: 'hide' }, X: { do: 'showAll' }, p: { do: 'pin' }, '<': { do: 'width', f: 1 / 1.2 }, '>': { do: 'width', f: 1.2 }, '=': { do: 'fit' },
  y: { do: 'copy', row: false }, Y: { do: 'copy', row: true }, o: { do: 'settings' }, R: { do: 'reset' }, q: { do: 'exit' }, 'C-]': { do: 'exit' },
};

const O = ja.csvOps;
/** 操作パネルの CSV の節(4.4)。マウスだけでも全部の操作ができるように */
export const csvCommands: CommandDef<CsvAction>[] = [
  { id: csvKeys.s!, key: 's', label: O.sort }, { id: csvKeys.S!, key: 'S', label: O.sortAdd },
  { id: csvKeys.f!, key: 'f', label: O.filter }, { id: csvKeys.F!, key: 'F', label: O.clearFilters },
  { id: csvKeys['/']!, key: '/', label: O.search }, { id: csvKeys.n!, key: 'n', label: O.next }, { id: csvKeys.N!, key: 'N', label: O.prev },
  { id: csvKeys.Enter!, key: 'Enter', label: O.inspect }, { id: csvKeys[':']!, key: ':', label: O.jump },
  { id: csvKeys.r!, key: 'r', label: O.rename }, { id: csvKeys['+']!, key: '+', label: O.moreDecimals }, { id: csvKeys['-']!, key: '-', label: O.fewerDecimals },
  { id: csvKeys.m!, key: 'm', label: O.mark }, { id: csvKeys.M!, key: 'M', label: O.rules },
  { id: csvKeys.x!, key: 'x', label: O.hide }, { id: csvKeys.X!, key: 'X', label: O.showAll }, { id: csvKeys.p!, key: 'p', label: O.pin },
  { id: csvKeys['<']!, key: '<', label: O.narrower }, { id: csvKeys['>']!, key: '>', label: O.wider }, { id: csvKeys['=']!, key: '=', label: O.fit },
  { id: csvKeys.y!, key: 'y', label: O.copy }, { id: csvKeys.Y!, key: 'Y', label: O.copyRow },
  { id: csvKeys['g g']!, key: 'gg', label: O.top }, { id: csvKeys.G!, key: 'G', label: O.bottom },
  { id: csvKeys.o!, key: 'o', label: O.settings }, { id: csvKeys.R!, key: 'R', label: O.reset },
];
