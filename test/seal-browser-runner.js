/* global process: false */

// Headless-Chrome runner for the browser QUnit suite (test/index.html).
//
// Usage (Node with puppeteer-core resolvable, e.g. via NODE_PATH):
//   CHROME_BIN=/path/to/chrome node test/seal-browser-runner.js <url>
//
// Environment:
//   CHROME_BIN            Chrome/Chromium executable (required)
//   SEAL_QUNIT_URL        suite URL when no argument is given
//   SEAL_QUNIT_TIMEOUT_MS global timeout in ms (default 20 minutes)
//   SEAL_SKIP_TESTS       "||"-separated list of "module: test name" entries that
//                         are de-registered at declaration time
//
// This file is linted with test/.jshintrc (es3), so it is written in ES5 syntax.
( function() {
	"use strict";

	var puppeteer = require( "puppeteer-core" ),
		PREFIX = "__SEAL__",

		// "goto" is a reserved word under es3 linting
		GOTO = "goto",
		url = process.argv[ 2 ] || process.env.SEAL_QUNIT_URL ||
			"http://127.0.0.1:8000/test/index.html?dev",
		timeoutMs = parseInt( process.env.SEAL_QUNIT_TIMEOUT_MS || "1200000", 10 ),
		skipList = ( process.env.SEAL_SKIP_TESTS || "" ).split( "||" )
			.map( function( entry ) {
				return entry.replace( /^\s+|\s+$/g, "" );
			} )
			.filter( function( entry ) {
				return entry.length > 0;
			} ),
		startTime = Date.now(),
		browser = null,
		finished = false,
		modules = {},
		moduleOrder = [],
		pendingFailures = [],
		stats = { tests: 0, passed: 0, failed: 0, skipped: 0 },
		failedTests = [];

	// Runs inside every frame of the page before any page script.
	// Only the top frame is instrumented; the suite spawns iframes that
	// load their own QUnit/jQuery copies.
	function sealInstrument( skipEntries, prefix ) {
		if ( window !== window.top ) {
			return;
		}

		// Snapshot natives: the ajax "Using Native JSON" test replaces
		// window.JSON with a parse-only stub, and tests may stub console.
		var nativeJSON = window.JSON,
			nativeStringify = window.JSON.stringify,
			nativeConsole = window.console,
			nativeLog = window.console.log,
			skip = {},
			qunitRef,
			hooked = false,
			i;

		for ( i = 0; i < skipEntries.length; i++ ) {
			skip[ skipEntries[ i ] ] = true;
		}

		function emit( type, data ) {
			try {
				nativeLog.call( nativeConsole,
					prefix + nativeStringify.call( nativeJSON, { type: type, data: data } ) );
			} catch ( e ) {
				try {
					nativeLog.call( nativeConsole, prefix +
						"{\"type\":\"emitError\",\"data\":{\"message\":\"" +
						String( e ).replace( /["\\]/g, "'" ) + "\"}}" );
				} catch ( ignore ) {}
			}
		}

		function dump( Q, value ) {
			var out;
			try {
				out = Q.dump.parse( value );
			} catch ( e ) {
				try {
					out = String( value );
				} catch ( e2 ) {
					out = "[unprintable]";
				}
			}
			out = String( out );
			return out.length > 2000 ? out.slice( 0, 2000 ) + "...[truncated]" : out;
		}

		function hook( Q ) {
			var originalTest = Q.test;

			Q.config.reorder = false;

			// QUnit.asyncTest delegates to QUnit.test, so this covers both
			Q.test = function( testName ) {
				var current = Q.config.currentModule,
					moduleName = current && current.name ? current.name : "",
					key = moduleName + ": " + testName;
				if ( skip.hasOwnProperty( key ) ) {
					emit( "skipped", { module: moduleName, name: testName } );
					return;
				}
				return originalTest.apply( this, arguments );
			};

			Q.moduleStart( function( details ) {
				emit( "moduleStart", { name: details.name } );
			} );
			Q.testStart( function( details ) {
				emit( "testStart", { module: details.module, name: details.name } );
			} );
			Q.log( function( details ) {
				if ( details.result ) {
					return;
				}
				emit( "fail", {
					module: details.module,
					name: details.name,
					message: details.message === undefined ? "" : String( details.message ),
					actual: dump( Q, details.actual ),
					expected: dump( Q, details.expected ),
					source: details.source ? String( details.source ) : ""
				} );
			} );
			Q.testDone( function( details ) {
				emit( "testDone", {
					module: details.module,
					name: details.name,
					failed: details.failed,
					passed: details.passed,
					total: details.total,
					runtime: details.runtime,
					skipped: !!details.skipped
				} );
			} );
			Q.done( function( details ) {
				emit( "done", {
					failed: details.failed,
					passed: details.passed,
					total: details.total,
					runtime: details.runtime
				} );
			} );
		}

		Object.defineProperty( window, "QUnit", {
			configurable: true,
			enumerable: true,
			get: function() {
				return qunitRef;
			},
			set: function( value ) {
				qunitRef = value;
				if ( value && !hooked ) {
					hooked = true;
					try {
						hook( value );
					} catch ( e ) {
						emit( "emitError", { message: "hook failed: " + String( e ) } );
					}
				}
			}
		} );
	}

	function log( line ) {
		process.stdout.write( line + "\n" );
	}

	function pad( value, width ) {
		value = String( value );
		while ( value.length < width ) {
			value += " ";
		}
		return value;
	}

	function getModule( name ) {
		if ( !modules.hasOwnProperty( name ) ) {
			modules[ name ] = { tests: 0, passed: 0, failed: 0, skipped: 0,
				assertions: 0, assertionsPassed: 0 };
			moduleOrder.push( name );
		}
		return modules[ name ];
	}

	function printSummary( qunitDone, reason ) {
		var i, name, mod, assertions = 0, assertionsPassed = 0;

		log( "" );
		log( "==== SEAL QUNIT PER-MODULE RESULTS ====" );
		log( pad( "module", 16 ) + pad( "tests", 8 ) + pad( "passed", 8 ) +
			pad( "failed", 8 ) + pad( "skipped", 9 ) + "assertions" );
		for ( i = 0; i < moduleOrder.length; i++ ) {
			name = moduleOrder[ i ];
			mod = modules[ name ];
			assertions += mod.assertions;
			assertionsPassed += mod.assertionsPassed;
			log( pad( name || "(none)", 16 ) + pad( mod.tests, 8 ) + pad( mod.passed, 8 ) +
				pad( mod.failed, 8 ) + pad( mod.skipped, 9 ) +
				mod.assertionsPassed + "/" + mod.assertions );
		}

		if ( failedTests.length ) {
			log( "" );
			log( "Failed tests:" );
			for ( i = 0; i < failedTests.length; i++ ) {
				log( "  - " + failedTests[ i ] );
			}
		}

		if ( qunitDone ) {
			assertions = qunitDone.total;
			assertionsPassed = qunitDone.passed;
		}

		log( "" );
		log( "SEAL QUNIT SUMMARY: tests=" + stats.tests + " passed=" + stats.passed +
			" failed=" + stats.failed + " skipped=" + stats.skipped +
			" assertions=" + assertionsPassed + "/" + assertions +
			" runtime=" + ( qunitDone ? qunitDone.runtime : Date.now() - startTime ) + "ms" +
			( reason ? " (" + reason + ")" : "" ) );
	}

	function finish( code, qunitDone, reason ) {
		if ( finished ) {
			return;
		}
		finished = true;
		printSummary( qunitDone, reason );
		log( code === 0 ? "SEAL QUNIT RESULT: PASS" : "SEAL QUNIT RESULT: FAIL" );

		function exit() {
			process.exit( code );
		}
		if ( browser ) {
			browser.close().then( exit, exit );
			setTimeout( exit, 10000 );
		} else {
			exit();
		}
	}

	function handleEvent( event ) {
		var data = event.data || {},
			mod, i, failure;

		switch ( event.type ) {
		case "moduleStart":
			log( "" );
			log( "# module: " + data.name );
			break;
		case "fail":
			pendingFailures.push( data );
			break;
		case "skipped":
			stats.skipped++;
			getModule( data.module ).skipped++;
			log( "SKIPPED " + data.module + " :: " + data.name );
			break;
		case "testDone":
			mod = getModule( data.module );
			stats.tests++;
			mod.tests++;
			mod.assertions += data.total;
			mod.assertionsPassed += data.passed;
			if ( data.skipped ) {
				stats.skipped++;
				mod.skipped++;
				log( "skip " + data.module + " :: " + data.name );
			} else if ( data.failed > 0 ) {
				stats.failed++;
				mod.failed++;
				failedTests.push( data.module + " :: " + data.name );
				log( "not ok " + data.module + " :: " + data.name + " (" + data.passed +
					"/" + data.total + " assertions, " + data.runtime + "ms)" );
				for ( i = 0; i < pendingFailures.length; i++ ) {
					failure = pendingFailures[ i ];
					log( "    message:  " + failure.message );
					log( "    expected: " + failure.expected );
					log( "    actual:   " + failure.actual );
					if ( failure.source ) {
						log( "    source:   " +
							failure.source.split( "\n" ).join( "\n              " ) );
					}
				}
			} else {
				stats.passed++;
				mod.passed++;
				log( "ok " + data.module + " :: " + data.name + " (" + data.passed + "/" +
					data.total + " assertions, " + data.runtime + "ms)" );
			}
			pendingFailures = [];
			break;
		case "done":
			finish( stats.failed > 0 || data.failed > 0 ? 1 : 0, data );
			break;
		case "emitError":
			log( "SEAL RUNNER WARNING: " + data.message );
			break;
		}
	}

	function fail( reason ) {
		log( "SEAL RUNNER ERROR: " + reason );
		finish( 1, null, reason );
	}

	if ( !process.env.CHROME_BIN ) {
		log( "SEAL RUNNER ERROR: CHROME_BIN is not set" );
		process.exit( 1 );
	}

	log( "SEAL QUNIT URL: " + url );
	skipList.forEach( function( entry ) {
		log( "SEAL_SKIP_TESTS entry: " + entry );
	} );

	setTimeout( function() {
		fail( "global timeout of " + timeoutMs + "ms reached before QUnit.done" );
	}, timeoutMs );

	puppeteer.launch( {
		executablePath: process.env.CHROME_BIN,
		headless: "new",
		args: [ "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage" ]
	} ).then( function( launched ) {
		browser = launched;
		return browser.newPage();
	} ).then( function( page ) {
		page.on( "console", function( msg ) {
			var text = msg.text();
			if ( text.indexOf( PREFIX ) === 0 ) {
				try {
					handleEvent( JSON.parse( text.slice( PREFIX.length ) ) );
				} catch ( e ) {
					log( "SEAL RUNNER WARNING: bad event " + e + ": " + text.slice( 0, 300 ) );
				}
			}
		} );
		page.on( "pageerror", function( err ) {
			log( "PAGE ERROR: " + ( err && err.message ? err.message : err ) );
		} );
		page.on( "dialog", function( dialog ) {
			dialog.dismiss();
		} );
		return page.evaluateOnNewDocument( sealInstrument, skipList, PREFIX ).then( function() {
			return page[ GOTO ]( url, { waitUntil: "load", timeout: 120000 } );
		} );
	} ).then( function( response ) {
		if ( response && !response.ok() ) {
			fail( "suite page returned HTTP " + response.status() );
		}
	}, function( err ) {
		fail( "browser/navigation failure: " + ( err && err.stack ? err.stack : err ) );
	} );
} )();
