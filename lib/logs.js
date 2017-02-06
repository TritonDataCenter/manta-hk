/* vim: set ts=8 sts=8 sw=8 noet: */

var mod_assert = require('assert-plus');
var mod_vasync = require('vasync');
var mod_extsprintf = require('extsprintf');

var printf = mod_extsprintf.printf;
var sprintf = mod_extsprintf.sprintf;

function eprintf()
{
	process.stderr.write(sprintf.apply(null,
	    Array.prototype.slice.call(arguments)));
}

function baseLogPath(service, when)
{
	return (sprintf('/poseidon/stor/logs/%s/%04d/%02d/%02d/%02d',
	    service, when.getUTCFullYear(), when.getUTCMonth() + 1,
	    when.getUTCDate(), when.getUTCHours()));
}

function listLogs(config, done)
{
	var dt = new Date();

	var start = new Date(config.start);

	start.setUTCMilliseconds(0);
	start.setUTCSeconds(0);
	start.setUTCMinutes(0);
	start.setUTCHours(start.getUTCHours() - config.before);

	var end = new Date(config.start);

	end.setUTCMilliseconds(0);
	end.setUTCSeconds(0);
	end.setUTCMinutes(0);
	end.setUTCHours(end.getUTCHours() + config.after);

	var makeContext = function (service, serviceDir) {
		return ({
			llfs_service: service,
			llfs_serviceDir: serviceDir,
			llfs_first: new Date(start),
			llfs_last: new Date(end),
			llfs_current: null,
			llfs_manta: config.manta,
			llfs_emit: config.logCallback,
			llfs_inflight: 0
		});
	};

	mod_vasync.forEachPipeline({ inputs: config.services,
	    func: function (service, next) {
		/*
		 * Check that the top-level directory for logs of this
		 * type exists.
		 */
		var path = sprintf('/poseidon/stor/logs/%s', service);

		config.manta.info(path, function (err, res) {
			if (err && err.name === 'NotFoundError') {
				eprintf('ERROR: "%s" is not a real ' +
				    'service\n', service);
				next();
				return;
			}

			if (err) {
				eprintf('FATAL: %s\n', err.stack);
				next(err);
				return;
			}

			listLogsForService(makeContext(service, service),
			    function (err) {
				if (err) {
					next(err);
					return;
				}

				if (service === 'mako-access' ||
				    service === 'mako-error') {
					listLogsForService(makeContext(
					    service, service + '.log'), next);
					return;
				}

				next();
			});
		});
	}}, done);
}

function listLogsForService(llfs, done)
{
	mod_assert.ok(llfs.llfs_inflight >= 0, 'inflight > 0 (' +
	    llfs.llfs_inflight + ')');

	if (llfs.llfs_inflight >= 8) {
		return;
	}

	if (llfs.llfs_current === null) {
		llfs.llfs_current = new Date(llfs.llfs_first);
	} else {
		llfs.llfs_current.setUTCHours(
		    llfs.llfs_current.getUTCHours() + 1);
	}

	if (llfs.llfs_current.valueOf() > llfs.llfs_last.valueOf()) {
		if (llfs.llfs_inflight < 1) {
			setImmediate(done);
		}
		return;
	}

	llfs.llfs_inflight++;

	var path = baseLogPath(llfs.llfs_serviceDir, llfs.llfs_current);
	var dt = new Date(llfs.llfs_current);

	llfs.llfs_manta.ls(path, function (err, res) {
		var count = 0;


		if (err) {
			if (err.name !== 'NotFoundError') {
				eprintf('ERROR: %s\n', err.name);
			}
			llfs.llfs_inflight--;
			setImmediate(listLogsForService, llfs, done);
			return;
		}

		res.on('object', function (obj) {
			count++;
			llfs.llfs_emit({
				service: llfs.llfs_service,
				date: dt,
				dir: path,
				name: obj.name,
				size: obj.size
			});
		});

		res.on('end', function () {
			//eprintf('\tcount: %d\n', count);
			llfs.llfs_inflight--;
			setImmediate(listLogsForService, llfs, done);
		});
	});

	setImmediate(listLogsForService, llfs, done);
}


module.exports = {
	listLogs: listLogs
};
