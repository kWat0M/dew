// アイコン: Google の Material Symbols(Rounded、太さ 400)の SVG をそのまま使う
// (@material-symbols/svg-400、Apache-2.0)。使うものだけがビルドに入る。色は currentColor
import folder from '@material-symbols/svg-400/rounded/folder-fill.svg?raw';
import image from '@material-symbols/svg-400/rounded/image-fill.svg?raw';
import movie from '@material-symbols/svg-400/rounded/movie-fill.svg?raw';
import audio from '@material-symbols/svg-400/rounded/music_note-fill.svg?raw';
import file from '@material-symbols/svg-400/rounded/draft-fill.svg?raw';
import lock from '@material-symbols/svg-400/rounded/lock-fill.svg?raw';
import home from '@material-symbols/svg-400/rounded/home.svg?raw';
import canvas from '@material-symbols/svg-400/rounded/select_window.svg?raw';
import play from '@material-symbols/svg-400/rounded/play_arrow-fill.svg?raw';
import pause from '@material-symbols/svg-400/rounded/pause-fill.svg?raw';
import playCircle from '@material-symbols/svg-400/rounded/play_circle-fill.svg?raw';
import pauseCircle from '@material-symbols/svg-400/rounded/pause_circle-fill.svg?raw';
import back5 from '@material-symbols/svg-400/rounded/replay_5.svg?raw';
import back30 from '@material-symbols/svg-400/rounded/replay_30.svg?raw';
import fwd5 from '@material-symbols/svg-400/rounded/forward_5.svg?raw';
import fwd30 from '@material-symbols/svg-400/rounded/forward_30.svg?raw';
import frameBack from '@material-symbols/svg-400/rounded/skip_previous-fill.svg?raw';
import frameNext from '@material-symbols/svg-400/rounded/skip_next-fill.svg?raw';
import close from '@material-symbols/svg-400/rounded/close.svg?raw';
import fullscreen from '@material-symbols/svg-400/rounded/fullscreen.svg?raw';
import volume from '@material-symbols/svg-400/rounded/volume_up-fill.svg?raw';
import volumeOff from '@material-symbols/svg-400/rounded/volume_off-fill.svg?raw';
import grid from '@material-symbols/svg-400/rounded/grid_view.svg?raw';
import list from '@material-symbols/svg-400/rounded/list.svg?raw';
import minimize from '@material-symbols/svg-400/rounded/minimize.svg?raw';
import maximize from '@material-symbols/svg-400/rounded/crop_square.svg?raw';
import restore from '@material-symbols/svg-400/rounded/filter_none.svg?raw';
import history from '@material-symbols/svg-400/rounded/history.svg?raw';
import help from '@material-symbols/svg-400/rounded/help.svg?raw';
import menu from '@material-symbols/svg-400/rounded/more_vert.svg?raw';
import power from '@material-symbols/svg-400/rounded/power_settings_new.svg?raw';
import tile from '@material-symbols/svg-400/rounded/view_quilt.svg?raw';
import free from '@material-symbols/svg-400/rounded/picture_in_picture.svg?raw';
import search from '@material-symbols/svg-400/rounded/search.svg?raw';
import sync from '@material-symbols/svg-400/rounded/sync.svg?raw';
import compare from '@material-symbols/svg-400/rounded/compare.svg?raw';
import zoomIn from '@material-symbols/svg-400/rounded/zoom_in.svg?raw';
import zoomOut from '@material-symbols/svg-400/rounded/zoom_out.svg?raw';
import keyboard from '@material-symbols/svg-400/rounded/keyboard.svg?raw';
import record from '@material-symbols/svg-400/rounded/radio_button_checked.svg?raw';
import stopRecord from '@material-symbols/svg-400/rounded/stop_circle-fill.svg?raw';
import article from '@material-symbols/svg-400/rounded/article-fill.svg?raw';
import './icons.css';

const svgs = {
  folder, image, movie, audio, file, lock, home, canvas,
  play, pause, playCircle, pauseCircle, back5, back30, fwd5, fwd30, frameBack, frameNext,
  close, fullscreen, volume, volumeOff, grid, list, minimize, maximize, restore,
  history, help, menu, power, tile, free, search, sync, compare, zoomIn, zoomOut, keyboard, record, stopRecord, article,
};

export type IconName = keyof typeof svgs;

export function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  // 同梱の SVG ファイルの中身なので、そのまま埋め込んでよい
  return <span className="icon" style={{ width: size, height: size }} aria-hidden="true" dangerouslySetInnerHTML={{ __html: svgs[name] }} />;
}
