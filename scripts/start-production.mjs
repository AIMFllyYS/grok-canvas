import { cp, access } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const output=path.resolve(root,process.env.GROK_CANVAS_BUILD_DIR||".next");
const standalone=path.join(output,"standalone");
const server=path.join(standalone,"server.js");
try{await access(server);}catch{throw new Error("Production build is missing. Run pnpm build first.");}
// Next's standalone output deliberately excludes these two public directories.
await cp(path.join(root,"public"),path.join(standalone,"public"),{recursive:true,force:true});
await cp(path.join(output,"static"),path.join(standalone,path.basename(output),"static"),{recursive:true,force:true});
process.env.NODE_ENV="production";
process.env.HOSTNAME="127.0.0.1";
process.env.PORT="3210";
await import(pathToFileURL(server).href);
