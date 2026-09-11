import http from "node:http";
export const healthPayload=()=>({service:"fuel-impact",status:"ok"});
const s=http.createServer((q,r)=>{if(q.url!=="/health"){r.writeHead(404).end();return;}r.writeHead(200,{"content-type":"application/json"}).end(JSON.stringify(healthPayload()));});
if(process.env.NODE_ENV!=="test")s.listen(Number(process.env.PORT??8080),"0.0.0.0");
