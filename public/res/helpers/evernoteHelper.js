define([
    "jquery",
    "constants",
    "core",
    "utils",
    "storage",
    "logger",
    "eventMgr",
    "classes/AsyncTask"
], function($, constants, core, utils, storage, logger, eventMgr, AsyncTask) {

    var oauthParams;

    var evernoteHelper = {};

    // Listen to offline status changes
    var isOffline = false;
    eventMgr.addListener("onOfflineChanged", function(isOfflineParam) {
        isOffline = isOfflineParam;
    });

    // Only used to check the offline status
    function connect(task) {
		task.onRun(function() {
			if(isOffline === true) {
				client = undefined;
				return task.error(new Error("Operation not available in offline mode.|stopPublish"));
			}
			if(client !== undefined) {
				return task.chain();
			}
			$.ajax({
				url: "libs/evernote.min.js",
				dataType: "script",
				timeout: constants.AJAX_TIMEOUT
			}).done(function() {
				client = new Evernote.Client({
					consumerKey: constants.EVERNOTE_APP_KEY ,
					consumerSecret: constants.EVERNOTE_APP_SECRET
				});
				client.authDriver(new Dropbox.AuthDriver.Popup({
					receiverUrl: constants.BASE_URL + "html/dropbox-oauth-receiver.html",
					rememberUser: true
				}));
				task.chain();
			}).fail(function(jqXHR) {
				var error = {
					status: jqXHR.status,
					responseText: jqXHR.statusText
				};
				handleError(error, task);
			});
		});
    }

    // Try to authenticate with OAuth
    function authenticate(task) {
        var authWindow;
        var intervalId;
        task.onRun(function() {
            if(oauthParams !== undefined) {
                task.chain();
                return;
            }
            var serializedOauthParams = storage.evernoteOauthParams;
            if(serializedOauthParams !== undefined) {
                oauthParams = JSON.parse(serializedOauthParams);
                task.chain();
                return;
            }
            var errorMsg = "Failed to retrieve a token from evernote.";
            // We add time for user to enter his credentials
            task.timeout = constants.ASYNC_TASK_LONG_TIMEOUT;
            var oauth_object;
            function getOauthToken() {
                $.getJSON(constants.evernote_PROXY_URL + "request_token", function(data) {
                    if(data.oauth_token !== undefined) {
                        oauth_object = data;
                        task.chain(oauthRedirect);
                    }
                    else {
                        task.error(new Error(errorMsg));
                    }
                });
            }
            function oauthRedirect() {
                utils.redirectConfirm('You are being redirected to <strong>evernote</strong> authorization page.', function() {
                    task.chain(getVerifier);
                }, function() {
                    task.error(new Error('Operation canceled.'));
                });
            }
            function getVerifier() {
                storage.removeItem("evernoteVerifier");
                authWindow = utils.popupWindow('html/evernote-oauth-client.html?oauth_token=' + oauth_object.oauth_token, 'stackedit-evernote-oauth', 800, 600);
                authWindow.focus();
                intervalId = setInterval(function() {
                    if(authWindow.closed === true) {
                        clearInterval(intervalId);
                        authWindow = undefined;
                        intervalId = undefined;
                        oauth_object.oauth_verifier = storage.evernoteVerifier;
                        if(oauth_object.oauth_verifier === undefined) {
                            task.error(new Error(errorMsg));
                            return;
                        }
                        storage.removeItem("evernoteVerifier");
                        task.chain(getAccessToken);
                    }
                }, 500);
            }
            function getAccessToken() {
                $.getJSON(constants.evernote_PROXY_URL + "access_token", oauth_object, function(data) {
                    if(data.access_token !== undefined && data.access_token_secret !== undefined) {
                        storage.evernoteOauthParams = JSON.stringify(data);
                        oauthParams = data;
                        task.chain();
                    }
                    else {
                        task.error(new Error(errorMsg));
                    }
                });
            }
            task.chain(getOauthToken);
        });
        task.onError(function() {
            if(intervalId !== undefined) {
                clearInterval(intervalId);
            }
            if(authWindow !== undefined) {
                authWindow.close();
            }
        });
    }

	evernoteHelper.picker = function() {
		var paths = [];
		var task = new AsyncTask();
		// Add some time for user to choose his files
		task.timeout = constants.ASYNC_TASK_LONG_TIMEOUT;
		connect(task);
		loadPicker(task);
		task.onRun(function() {
			var options = {};
			options.multiselect = true;
			options.linkType = "direct";
			options.success = function(files) {
				for(var i = 0; i < files.length; i++) {
					var path = files[i].link;
					path = path.replace(/.*\/view\/[^\/]*/, "");
					paths.push(decodeURI(path));
				}
				task.chain();
			};
			options.cancel = function() {
				task.chain();
			};
			Dropbox.choose(options);
		});
		task.onSuccess(function() {
			callback(undefined, paths);
		});
		task.onError(function(error) {
			callback(error);
		});
		task.enqueue();
	};
	
    evernoteHelper.upload = function(blogHostname, postId, tags, format, state, date, title, content, callback) {
        var task = new AsyncTask();
        connect(task);
        authenticate(task);
        task.onRun(function() {
            var data = $.extend({
                blog_hostname: blogHostname,
                post_id: postId,
                tags: tags,
                format: format,
                state: state,
                date: date,
                title: title,
                content: content
            }, oauthParams);
            $.ajax({
                url: constants.evernote_PROXY_URL + "post",
                data: data,
                type: "POST",
                dataType: "json",
                timeout: constants.AJAX_TIMEOUT
            }).done(function(post) {
                postId = post.id;
                task.chain();
            }).fail(function(jqXHR) {
                var error = {
                    code: jqXHR.status,
                    message: jqXHR.statusText
                };
                // Handle error
                if(error.code === 404 && postId !== undefined) {
                    error = 'Post ' + postId + ' not found on evernote.|removePublish';
                }
                handleError(error, task);
            });
        });
        task.onSuccess(function() {
            callback(undefined, postId);
        });
        task.onError(function(error) {
            callback(error);
        });
        task.enqueue();
    };

    function handleError(error, task) {
        var errorMsg;
        if(error) {
            logger.error(error);
            // Try to analyze the error
            if(typeof error === "string") {
                errorMsg = error;
            }
            else {
                errorMsg = "Could not publish on evernote.";
                if(error.code === 401 || error.code === 403) {
                    oauthParams = undefined;
                    storage.removeItem("evernoteOauthParams");
                    errorMsg = "Access to evernote account is not authorized.";
                    task.retry(new Error(errorMsg), 1);
                    return;
                }
                else if(error.code <= 0) {
                    core.setOffline();
                    errorMsg = "|stopPublish";
                }
            }
        }
        task.error(new Error(errorMsg));
    }

    return evernoteHelper;
});
