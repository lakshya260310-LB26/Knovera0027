import {createApp} from './app.mjs';
const instance=createApp();
const port=Number(process.env.PORT || 3000);
const host=process.env.NODE_ENV==='production'?'0.0.0.0':'127.0.0.1';
const server=instance.app.listen(port,host,()=>{console.log(`Knovera ${instance.demo?'DEMO':'LIVE'} ready at http://${host}:${port}`);instance.startJobs();});
server.on('error',error=>{console.error('Could not start Knovera:',error.message);instance.close();process.exit(1);});
function stop(){server.close(()=>{instance.close();process.exit(0);});}
process.on('SIGTERM',stop);process.on('SIGINT',stop);
