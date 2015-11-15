fs = require('fs');
crypto = require('crypto');
Evernote = require('evernote').Evernote;

exports.test = function test(req, res) {
	// Real applications authenticate with Evernote using OAuth, but for the
	// purpose of exploring the API, you can get a developer token that allows
	// you to access your own Evernote account. To get a developer token, visit
	// https://sandbox.evernote.com/api/DeveloperToken.action
 
	var consumerKey = 'littleduck';
	var consumerSecret = 'ad99f833bd2cb85c';

	// Initial development is performed on our sandbox server. To use the production
	// service, change sandbox: false and replace your
	// developer token above with a token from
	// https://www.evernote.com/api/DeveloperToken.action
	var client = new Evernote.Client({
		'consumerKey': consumerKey,
		'consumerSecret': consumerSecret,
		'sandbox': true
	});
	
	client.getRequestToken('http://182.254.229.232/yinxiang/callback', function(error, tmpToken, oauthTokenSecret, results) {
		// store tokens in the session
		// and then redirect to client.getAuthorizeUrl(oauthToken)
		console.log("tmpToken: " + tmpToken);
	});

};


exports.callback = function(req, res) {
	console.log("xixixixixixixix");
};

