import { Runtime } from "foldkit";
import { Model, init, update, view } from "./main.ts";

Runtime.run(Runtime.makeApplication({ Model, init, update, view, container: document.getElementById("root")! }));
