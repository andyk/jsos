const exitHook = require('exit-hook');
exitHook((signal: any) => {
	console.log(`Exiting with signal: ${signal}`);
});