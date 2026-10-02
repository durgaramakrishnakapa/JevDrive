import "./style.css";
import { Game } from "./game/Game";

const canvas = document.getElementById("game-canvas") as HTMLCanvasElement;
new Game(canvas);
