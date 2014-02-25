/*******************************************************************************
  iGenie (code name: AjaxFrame)
  Copyright 2009. Heath Schweitzer Holdings, LLC.  All Rights Reserved.
*******************************************************************************/

/*
 * @todo Add HTTP error pages with option of going back or retrying? We can just allow the
 * @todo We should attempt to do CSS scoped (should we rewrite the rules?). In HTML5, can <link> be scoped? We might have to insert styles inline
 * @todo Add option to fallback if an error occurs in the operation of the AjaxFrame code, either to replace rootElement with iframe whose src is the same as the current history pos, or to fallback to the original fallback content. Or to show a retry message or some custom error?
 */

if(!window.AjaxFrame)
	var AjaxFrame = {};
if(!AjaxFrame.instances)
	AjaxFrame.instances = [];

/*
Each instance may contain the following members:

- id: Unique ID that is used by the page to interact with the AjaxFrame, and ID to associate current page in URL Hash
- src: The URL for where to load the initial content for the AjaxFrame
- proxy: Service via which the src should loaded via JSON-P
- intialized: If does not evaluate to true, then instance has not been initialized (readonly)
- _pendingNodes: When in the process of building the DOM, some elements need to be inserted after insertion (readonly)
- rootElement: Once initialized, this returns the DOM element representing the AjaxFrame (@todo, why placeholder and this?)
- insertedNodes: A list of all of the nodes that the instance has inserted into the DOM: includes element, but more importantly any nodes inserted into the HEAD
- history: A list of all the pages previously visited in the AjaxFrame, starting with the most recently visited
*/


(function(){

// If this script is included multiple times, only execute the first one, but
// still do init() because there may be new instances needing to initialize
if(AjaxFrame.init){
	AjaxFrame.init();
	return;
}

var isOldIE = /MSIE [1-7]\D/.test(navigator.userAgent);

var instanceCount = 0;
var globalRequestCount = 0;
var tempID = 1;

if(!AjaxFrame.proxy)
	AjaxFrame.proxy = 'http://igenie.local/proxy.php'; //may be overridden
//if(typeof AjaxFrame.isDomLoaded == 'undefined')
//	AjaxFrame.isDomLoaded = false;


/**
 * This function is called every time a script is executed and whenever
 * DOMContentLoad and window load events fire; this is so that one single
 * ajaxframe.js script can be included at the end of a document in addition to
 * being placed inline with the content. So this function needs to only
 * initialize the instances that haven't been initialized yet
 * @this {AjaxFrame}
 */
AjaxFrame.init = function init(e){
	var that = this;
	if(!e)
		e = window.event;
	//this.isDomLoaded = e && e.type.toLowerCase().indexOf('load') != -1;
	
	//Get the very last script element which is what has loaded this file. Once
	// all of the options have been parsed off of the script, then delete each.
	var scripts = [];
	forEach(document.getElementsByTagName('script'), function(script){
		//@todo Should we just look at the script.src for 'ajaxframe' instead?
		if(/ajaxframe/.test(script.className) && !script.getAttribute('data-inspected')){
			var instance = {
				src: script.getAttribute('data-src'),
				proxy: script.getAttribute('data-proxy') || that.proxy,
				id:script.getAttribute('data-id')
			};
			
			//Get the placeholder
			var rootElementID = script.getAttribute('data-rootElement-id') || script.getAttribute('data-rootElement');
			if(rootElementID){
				instance.rootElement = document.getElementById(rootElementID);
				//if(!instance.rootElement)
					//throw Error("AjaxFrame: No root element exists with an ID " + rootElementID);
			}
			else instance.rootElement = script;
			
			//Get whether bookmarkable
			var isBookmarkable = script.getAttribute('data-bookmarkable');
			instance.bookmarkable = !!((isBookmarkable && isBookmarkable != 'false') || isBookmarkable == '');
			
			//Get class name
			var rootClass = script.getAttribute('data-class');
			if(rootClass)
				instance.className = rootClass;
			
			//Scripting
			if(script.getAttribute('data-allowScripting'))
				instance.allowScripting = script.getAttribute('data-allowScripting');
			
			//if(!instance.src || !instance.proxy)
				//throw Error("Missing valid data-placeholder-id or data-src attribute");
			that.instances.push(instance);
			
			//Prevent script from being initialized twice
			script.setAttribute('data-inspected', 1); 
		}
	});
	
	//Initialize all of the uninitialized instances
	for(var i = 0; i < this.instances.length; i++){
		if(!this.instances[i]._initialized){
			this.instances[i] = new AjaxFrame.Instance(this.instances[i]); //does init
			this.instances[this.instances[i].id] = this.instances[i]; //shortcut
		}
	}
}


/**
 * All of AjaxFrame.instances get the prototype of the following
 * @constructor
 * @param {Object} config
 */
AjaxFrame.Instance = function(config){
	try {
		instanceCount++;
		var that = this;
		forIn(config, function(key, value){
			that[key] = value;
		});
		
		if(!this.src)
			throw Error("You must provide an initial URL (src) for the AjaxFrame");
		if(typeof this.rootElement == 'string')
			this.rootElement = document.getElementById(this.rootElement);
		if(!this.rootElement)
			throw Error("rootElement must be a valid DOM element in the document");
		
		//Save the fallback element for future use in case this initialization fails
		this.fallbackElement = this.rootElement.cloneNode(true);
		
		//Scripting
		switch(String(this.allowScripting).toLowerCase()){
			case 'always':
				this.allowScripting = 'always';
				break;
			case 'never':
				this.allowScripting = 'never';
				break;
			case 'sameparentdomain':
				this.allowScripting = 'sameParentDomain';
				break;
			default:
				this.allowScripting = 'sameInitialDomain'; //default
		}
		
		//Get a unique ID 
		var baseID = this.id;
		if(!baseID){
			baseID = "ajaxframe";
			this.id = baseID + instanceCount.toString();
		}
		while(AjaxFrame.instances[this.id])
			this.id = baseID + instanceCount.toString();
		
		//Get the initial domain for the AjaxFrame: used for allowScripting option
		this._initialSrc = this.src;
		this._initialDomain = parse_url(this.src).host;
		
		//Override this.src if one is provided in the hash, and for security concerns,
		// make sure that the URL in the hash has the same domain as the current
		// this.src. Otherwise, someone could construct a link to load in arbitrary
		// HTML+JavaScript and execute commands in their session on the site.
		// This highlights the need for Google Caja to filter JavaScript
		// UPDATE: This is now accounted for by this._initialDomain == 'sameInitialDomain'
		var hashMatch = location.hash.substr(1).match(new RegExp('(?:^|\\|)' + this.id + ':(.+?)(?:$|\\|)'));
		if(hashMatch){ // && this._initialDomain && this._initialDomain != parseDomain(hashMatch[1])
			//var _initialDomain = this.src.match(/(http:\/\/.+?\/)/);
			//if(_initialDomain && _initialDomain[1].indexOf(hashMatch[1])){
			this.src = hashMatch[1];
			//}
		}
	
		this._otherInsertedNodes = [];
		this._pendingNodes = [];
		//this.activeRequest = null;
		
		/**
		 * Each AjaxFrame instance object has a 'history' member that is an instance
		 * of the AjaxFrame.History class. This, obviously, manages the history of
		 * each individual frame as window.history does for the containing document.
		 * Note that this History is also an Array that contains the entire history
		 * with a 'current' member which is an index for the array indicating the
		 * current state.
		 */
		var frame = this;
		this.history = new Array();
		this.history.pos = -1;
		
		//For the following methods, see: https://developer.mozilla.org/en/DOM/window.history
		this.history.go = function(delta){
			//this.pos += delta;
			//frame.navigate(this[this.pos], true);
			frame.navigate(null, delta);
		};
		this.history.back = function(){
			this.go(-1);
		};
		this.history.forward = function(){
			this.go(+1);
		};
		if(this.history.__defineGetter__){
			this.history.__defineGetter__('current', function(){
				return this[this.pos];
			});
			this.history.__defineGetter__('previous', function(){
				return this[this.pos-1];
			});
			this.history.__defineGetter__('next', function(){
				return this[this.pos+1];
			});
		}
		
		this._initialized = true;
		
		//Do everything else!
		this.navigate(this.src);
	}
	catch(e){
		this.showFallback();
		
		//Announce error on console
		setTimeout(function(){
			if(window.console && console.error)
				console.error(e);
			throw e;
		}, 0);
	}
};

/** @typedef {Object} */
AjaxFrame.Instance;

AjaxFrame.Instance.prototype.id = null;
AjaxFrame.Instance.prototype.history = null;
AjaxFrame.Instance.prototype.src = null;
AjaxFrame.Instance.prototype.proxy = AjaxFrame.proxy;
AjaxFrame.Instance.prototype.baseURL = '';
AjaxFrame.Instance.prototype.allowScripting = 'sameInitialDomain';
AjaxFrame.Instance.prototype.status = null;
AjaxFrame.Instance.prototype.readyState = null;
AjaxFrame.Instance.prototype.rootElementNodeName = 'div';
AjaxFrame.Instance.prototype.bookmarkable = false;
AjaxFrame.Instance.prototype.className = 'ajaxframe';
AjaxFrame.Instance.prototype.rootElement = null;
AjaxFrame.Instance.prototype.fallbackElement = null;

//Private
AjaxFrame.Instance.prototype._initialSrc = null;
AjaxFrame.Instance.prototype._initialized = false;
AjaxFrame.Instance.prototype._pendingNodes = null;
AjaxFrame.Instance.prototype._requestCount = 0;
AjaxFrame.Instance.prototype._initialDomain = null;
AjaxFrame.Instance.prototype._otherInsertedNodes = null;
AjaxFrame.Instance.prototype._isAllowingScripting = null;

/**
 * May be invoked at any time to display the fallback content
 * @this {AjaxFrame.Instance}
 */
AjaxFrame.Instance.prototype.showFallback = function showFallback(newFallbackElement){
	var fallback = newFallbackElement || this.fallbackElement;
	
	//If a noscript element, then get the text content which is HTML code
	// @todo This actually doesn't work in IE or WebKit
	if(fallback.nodeName.toLowerCase() == 'noscript'){
		var div = document.createElement('div');
		div.innerHTML = fallback.textContent || fallback.innerText || fallback.innerHTML;
		div.className = this.className + ' fallback';
		fallback = div;
	}
	
	//Replace root element with fallback
	this.rootElement = this.rootElement.parentNode.replaceChild(fallback, this.rootElement);
	
	
	
	
	//if(instance.rootElement && instance.rootElement.parentNode){
	//	if(instance.rootElement.nodeName.toLowerCase() == 'noscript'){
	//		var div = document.createElement(div);
	//		if(instance.className)
	//			div.className = instance.className;
	//		div.innerHTML = instance.rootElement.textContent;
	//		instance.rootElement.parentNode.replaceChild(div, instance.rootElement);
	//	}
	//	else {
	//		//@todo
	//		instance.rootElement.style.display = 'block';
	//	}
	//}

}

//Akin XMLHttpRequest
/** @const */
var STATE_UNSENT = 0;
/** @const */
var STATE_LOADING = 3;
/** @const */
var STATE_DONE = 4;
AjaxFrame.Instance.prototype.readyState = STATE_UNSENT;

/**
 * Hash change handler; this will get called at least once
 * @param {Object} e Event object if invoked as hashchange
 * @private
 */
function onhashchange(e){
	if(!e)
		e = window.event;
    if(hashchangeTimerID && e && e.type.indexOf('hashchange') != -1){
		clearInterval(hashchangeTimerID);
		hashchangeTimerID = null;
    }
	
	//Prevent this event handler from calling instance.navigate() if it is what changed the hash
	if(onhashchange.isSuppressed){
		onhashchange.isSuppressed = Math.max(onhashchange.isSuppressed - 1, 0);
		return;
	}
	
	//Look at the instance ID in the hash data
	var existingHash = window.location.hash.substr(1);
	
	//If not existing Hash, then we should go to the very beginning of the histories
	if(!existingHash){
		forEach(AjaxFrame.instances, function(instance){
			instance.navigate('', -instance.history.pos);
		});
	}
	//Otherwise, parse the hash for all of the states that we need to go to
	else {
		//Any instance not seen should be set to initial history position, so keep track
		var instancesChanged = {};
		
		forEach(existingHash.split(/\|/), function(instanceState){
			var instance, match;
			if((match = instanceState.match(/(.+?):(.+)/)) && (instance = AjaxFrame.instances[match[1]])){
				var url = match[2];
				instancesChanged[instance.id] = true;
				
				//Now check to see if url is the next adjacent to our current
				// position in the history
				if(url == instance.history[instance.history.pos])
					return;
				
				//Now check to see if url is same as forward
				if(instance.history[instance.history.pos+1] == url){
					instance.navigate(null, +1);
				}
				//Check to see if same as previous
				else if(instance.history[instance.history.pos-1] == url){
					instance.navigate(null, -1);
				}
				//Otherwise, push new instance onto stack
				//@todo: it could be that they went further than one backward or forward
				else {
					instance.navigate(url); //note: this should not have to change the URL hash! If it does, then that is bad!
				}
			}
		});
		
		//Now iterate over all of the instances, and if any weren't present in
		// the hash, set their history position to 0
		forEach(AjaxFrame.instances, function(instance){
			if(instancesChanged[instance.id] !== true){
				instance.history.go(-instance.history.pos);
			}
		});
	}
	
}


/**
 * Monitor the location hash for changes; this interval will get called at least
 * once and after that, if a native 'hashchange' handler gets called, then this
 * interval timer will be cleared. checkHashChange() starts once all of the
 * AjaxFrames have been initialized (onload).
 */
var previousHash; //This needs to be in the instance
var hashchangeTimerID;
function checkHashchange(){
	if(previousHash != location.hash){
		previousHash = location.hash;
		onhashchange();
	}
}



//For IE <= 7, we need to keep track of the has inside another iframe by actually
//changing the querystring.
//if(isOldIE&&false){
//	var doc = new ActiveXObject("htmlfile");
//	doc.open();
//	doc.write("<html>");
//	doc.write("<script>document.domain='" + location.host + "';</script>");
//	doc.write("</html>");
//	doc.close();
//	
//	var iframe = doc.createElement('iframe');
//	iframe.src = window.location.href;
//	alert(iframe.src)
//	//alert(iframe.contentWindow)
//	iframe.contentWindow.onload = function(){
//		alert(this)
//	};
//	doc.documentElement.appendChild(iframe);
//	
//	
//	//alert(1)
//	//  // we were served from child.example.com but
//	//  // have already set document.domain to example.com
//	//  var currentDomain = "http://exmaple.com/";
//	//  var dataStreamUrl = currentDomain+"path/to/server.cgi";
//	//  var transferDoc = new ActiveXObject("htmlfile"); // !?!
//	//  // make sure it's really scriptable
//	//  transferDoc.open();
//	//  transferDoc.write("<html>");
//	//  transferDoc.write("<script>document.domain='"+currentDomain+"';</script>");
//	//  transferDoc.write("</html>");
//	//  transferDoc.close();
//	//  // set the iframe up to call the server for data
//	//  var ifrDiv = transferDoc.createElement("div");
//	//  transferDoc.appendChild(ifrDiv);
//	//  // start communicating
//	//  ifrDiv.innerHTML = "<iframe src='"+dataStreamUrl+"'></iframe>";
//}

if(window.addEventListener){
	window.addEventListener('hashchange', onhashchange, false);
	window.addEventListener('load', function(){
		hashchangeTimerID = setInterval(checkHashchange, 100);
	}, false);
}
else if(window.attachEvent){
	window.attachEvent('onhashchange', onhashchange);
	window.attachEvent('onload', function(){
		hashchangeTimerID = setInterval(checkHashchange, 100);
	});
}


/**
 * If this is true, then the onhashchange event will not invoke
 * instance.navigate(). This is so that circular logic condition doesn't happen.
 * Once onhashchange is fired, then it resets it to false (by decrementing)
 * @type {number}
 */
onhashchange.isSuppressed = 0;



/**
 * Change the content displayed in the Ajax Frame
 * @param {string} url           If set, then will be the new URL navigated to. If empty, then historyDelta used
 * @param {number} historyDelta  The same number passed into history.go(); used to get the URL. If url supplied, this is ignored
 * @this {AjaxFrame.Instance}
 */
AjaxFrame.Instance.prototype.navigate = function(url, historyDelta){
	if(!url && !historyDelta)
		return; //we're not going anywhere!

	//Save the URL that we're currently on
	var existingURL = '';
	if(this.history.pos >= 0){
		existingURL = this.history[this.history.pos];
		if(existingURL == url)
			return; //nothing to do!
	}
	
	//Get the URL from the history
	if(!url){
		if(isNaN(historyDelta))
			throw Error('historyDelta must be an integer');
		if(!this.history.length)
			return; //nothing can be done!
		
		//Make sure new position is within bounds
		var newPos = Math.min(Math.max(0, this.history.pos + historyDelta), this.history.length-1);
		if(newPos == this.history.pos)
			return; //we're already there!
		this.history.pos = newPos;
		url = this.history[this.history.pos];
	}
	//Blow away the future history
	else {
		this.history.splice(this.history.pos+1, this.history.length - this.history.pos-1, url);
		this.history.pos++;
		if(this.history.pos+1 != this.history.length)
			throw Error("Unexpected!");
	}
	
	//If the new URL is the same as the previous URL except for the hash, then
	//  simply scroll to the new hash and return immediately
	if(existingURL && url.replace(/#.*$/, '') == existingURL.replace(/#.*$/, '')){
		var hash = url.replace(/^.*?(#|$)/, '');
		var targetEl = !hash ? this.rootElement : document.getElementById(hash);
		if(targetEl){
			scrollToElement(targetEl);
			//Update the page state with the new URL (changes location.hash)
			this._updateState(url);
			return; //we're done!
		}
	}
	
	this.baseURL = url.replace(/[^\/]+(\?.+)?(#.+?)?$/, ''); //dirname(path)
	
	//Use JSONP to get content via proxy
	this.readyState = STATE_UNSENT;
	var jsonpScript = document.createElement('script'); //jsonpScript.setAttribute('type', 'text/javascript');
	globalRequestCount++;
	var baseCallbackName = 'callback_' + globalRequestCount;
	jsonpScript.id = 'ajaxframe_' + baseCallbackName; //also unique callback name
	this._requestCount++;
	var originalRequestCount = this._requestCount;
	var that = this;
	//var pos = this.history.pos;
	AjaxFrame[baseCallbackName] = function(args){
		//Clean up by removing JSONP script element
		jsonpScript.parentNode.removeChild(document.getElementById(jsonpScript.id));
		AjaxFrame[baseCallbackName] = null;
		delete AjaxFrame[baseCallbackName];
		
		//If another request was made on this instance while this script was
		// loading, then abort and let the other request take over.
		if(originalRequestCount != that._requestCount){
			return;
		}
		
		//Account for the resulting URL if it is different than the requesting one (a redirect happened)
		if(url != args.url){
			that.history[that.history.pos] = args.url;
			that.baseURL = args.url.replace(/[^\/]+(\?.+)?(#.+?)?$/, ''); //dirname(path)
		}
		
		//Update the page state with the new URL (changes location.hash)
		that._updateState(args.url);
		
		that.status = args.status; //save the last status
		that._contentCallback(args); //_contentCallback.apply(that, [args]);
	};
	var scriptSrc = this.proxy + '?url=' + encodeURIComponent(url) + '&callback=AjaxFrame.' + baseCallbackName + "&rootElementNodeName=" + this.rootElementNodeName;
	if(isOldIE)
		scriptSrc += '&rand=' + Math.random();
	jsonpScript.setAttribute('src', scriptSrc);
	
	//Add busy indicator (these elements are going to get blown away upon load,
	// so it doesn't matter that we're mucking with them)
	this.rootElement.style.cursor = 'progress';
	//forEach(this.rootElement.getElementsByTagName('*'), function(el){
	//	el.style.cursor = 'progress';
	//});
	
	//The the jsonpScript element is inserted as following and not by appending it to the children of the HEAD or documentElement
	//  because of MSIE bug 'Error message when you visit a Web page or interact with a Web application in Internet Explorer: "Operation aborted"'
	//  See: <http://support.microsoft.com/default.aspx/kb/927917>
	var scripts = document.getElementsByTagName('script');
	var lastScript = scripts[scripts.length-1];
	lastScript.parentNode.insertBefore(jsonpScript, lastScript);
	this.readyState = STATE_LOADING;
};


/**
 * Update the state of page with a new URL
 * @private
 */
AjaxFrame.Instance.prototype._updateState = function _updateState(url){
	//Update the location.hash with the state for this ajaxframe
	var isInitialState = (this.history.pos == 0);
	var existingHash = location.hash.substr(1);
	var instanceStates = existingHash ? existingHash.split(/\|/) : [];
	var isInstanceStateSet = false;
	for(var i = 0; i < instanceStates.length; i++){
		//The hash state already has information about this AjaxFrame
		if(instanceStates[i].indexOf(this.id + ':') === 0){
			//Replace the state already in the hash
			if(!isInitialState){
				instanceStates[i] = this.id + ':' + url;
				isInstanceStateSet = true;
			}
			//Remove the instance information if/because it's not needed
			else if(this._requestCount > 1) {
				instanceStates.splice(i, 1); //remove
				i--;
			}
		}
	}
	//Add the needed state information to the hash if needed
	if(this.bookmarkable && (isInitialState ? this._requestCount > 1 : !isInstanceStateSet)){
		instanceStates.push(this.id + ':' + url);
	}
	
	//Only update the hash if it is different than the existing one
	var newHash = instanceStates.join('|');
	if(newHash != existingHash){
		onhashchange.isSuppressed++;
		self.location.hash = '#' + newHash;
	}
};



/**
 * When the JSON-P proxy returns, it calls a callback function when invokes this:
 * Applyied to AjaxFrame.Instance instance
 * @this {AjaxFrame.Instance}
 * @todo Make part of AjaxFrame.instance.prototype
 * @private
 */
AjaxFrame.Instance.prototype._contentCallback = function _contentCallback(args){
	var that = this;
	this.status = args.status;
	
	switch(this.allowScripting.toLowerCase()){
		case 'always':
			this._isAllowingScripting = true;
			break;
		case 'sameinitialdomain':
			this._isAllowingScripting = (parse_url(this._initialSrc).host == parse_url(args.url).host);
			break;
		case 'sameparentdomain':
			this._isAllowingScripting = (location.host == parse_url(args.url).host);
			break;
		default: //never
			this._isAllowingScripting = false;
	}
	
	//Remove all previously inserted elements
	while(this._otherInsertedNodes.length){
		var el = this._otherInsertedNodes.shift()
		if(el && el.parentNode)
			el.parentNode.removeChild(el);
	}
	
	//Provide error message
	//@todo The error message should be sent from proxy so this can be localized
	if(args.error){
		this.readyState = STATE_DONE;
		var errEl = document.createElement(this.rootElementNodeName);
		var em = document.createElement('em');
		em.appendChild(document.createTextNode(args.error));
		em.style.color = 'red';
		errEl.appendChild(em);
		this.rootElement.parentNode.replaceChild(errEl, this.rootElement);
		this.rootElement = errEl;
		this._delegateEventHandlers(errEl); //_delegateEventHandlers.apply(this, [errEl]);
		return;
	}
	
	//Add elements to the head
	if(args.headObjs && args.headObjs.length){
		var destHead = document.getElementsByTagName('head')[0];
		forEach(args.headObjs, function(elObj){
			var headEl = that._buildDOM(elObj); //_buildDOM.apply(that, [elObj]);
			that._otherInsertedNodes.push(destHead.appendChild(headEl));
		});
	}
	
	//Insert the new element into the body
	var bodyElement = that._buildDOM(args.bodyObj); //_buildDOM.apply(that, [args.bodyObj]);
	bodyElement.className += " " + this.className + " http-" + this.status;
	bodyElement.style.position = 'relative'; //necessary so CSS-positioned contents do much around with parent
	this.rootElement.parentNode.replaceChild(bodyElement, this.rootElement);
	this.rootElement = bodyElement;
	this._delegateEventHandlers(bodyElement); //_delegateEventHandlers.apply(this, [bodyElement]);
	
	//Chrome currently has a bug that requires scrolling to get content to show up
	if(navigator.userAgent.indexOf('Chrome') != -1){
		window.scrollBy(0,1);
		window.scrollBy(0,-1);
	}
	
	//Setup scripts and SWFs
	while(this._pendingNodes.length){
		var pending = this._pendingNodes.shift();
		//console.warn(pending.placeholder)
		switch(pending.type.toLowerCase()){
			case 'swf':
				var id = "ajaxframe-swfobject-" + tempID;
				tempID++;
				pending.placeholder.id = id;
				if(!this._isAllowingScripting)
					pending.attrs['allowScriptAccess'] = 'never';
				swfobject.embedSWF(
					pending.params.movie,
					id,
					pending.attrs.width,
					pending.attrs.height,
					'9.0.0', //@todo version
					null, //@todo expressInstallSwfurl
					null, //@todo flashvars??
					pending.params,
					pending.attrs,
					function(){}
				);
				break;
			case 'script':
				if(!this._isAllowingScripting)
					break;
				var script = document.createElement('script');
				forIn(pending.attrs, function(name, value){
					script.setAttribute(name, value);
				});
				pending.placeholder.parentNode.replaceChild(script, pending.placeholder);
				//console.warn(script)
				script.text = pending.textContent;
				break;
		}
		
	}
	
	this.readyState = STATE_DONE;
	
	//Scroll to the element identified in the fragment
	var hash = this.history[this.history.pos].replace(/^.+?(#|$)/, '');
	if(hash){
		var target = document.getElementById(hash);
		if(target)
			scrollToElement(target);
	}
	//Scroll to the top of the element if this isn't the initial request
	else if(this._requestCount > 1){
		//setTimeout(function(){
		scrollToElement(bodyElement, true/*onlyIfBelowFold*/);
		//}, 1000);
	}
}



/**
 * Do event delegation for click and submit
 * @todo Make part of AjaxFrame.instance.prototype
 * @this {AjaxFrame.Instance}
 */
AjaxFrame.Instance.prototype._delegateEventHandlers = function _delegateEventHandlers(el){
	var that = this;
	
	/**
	* Handle event delegation of 'click' event, looking for an href and then
	* acting upon it.
	*/
	function clickHandler(e){
		if(!e)
			e = window.event;
		var el = e.target ? e.target : e.srcElement;
		
		//Save the button what was clicked for the submit handler to know which
		// name/value pair to include along with the query
		if(el.name && ((el.nodeName.toLowerCase() == 'button') ||
		  (el.nodeName.toLowerCase() == 'input' && el.type.toLowerCase() == 'submit')))
		{
			var form = el;
			do {
				form = form.parentNode;
				if(form && form.nodeName.toLowerCase() == 'form'){
					if(!form.dataset)
						form.dataset = {};
					form.dataset.ajaxFrameActiveButtonName = el.name;
				}
			}
			while(form);
		}
		
		if(!el || (el.target && el.target != '_self')) //abort if link is going to a new window/parent
			return true;
		
		//Get the href of the element, or of a parent node that this has been embedded in
		var href;
		do {
			href = getLinkHref(el);
		}
		while(!href && (el = el.parentNode));
		
		if(!href)
			return true;
	
		if(e.preventDefault)
			e.preventDefault();
		else
			e.returnValue = false;
		that.navigate(href);
	
		return false;
	};
	
	/**
	* Handle event delegation of 'submit' event on a form element
	*/
	function submitHandler(e){
		if(!e)
			e = window.event;
		var form = e.target ? e.target : e.srcElement;
		if(!form || (form.method && form.method.toLowerCase() != 'get') ||
		   (form.target && form.target.toLowerCase() != '_self'))
		{
			return true;
		}
		
		//NOTE: We can't use these because Webkit doesn't support them, so we do ajaxFrameActiveButtonName
		//var activeElement = e.explicitOriginalTarget || document.activeElement;
		//if(activeElement){
		//	buttonName = form.dataset.ajaxFrameActiveButtonName
		//}
		var buttonName;
		if(form.dataset){
			buttonName = form.dataset.ajaxFrameActiveButtonName
			delete form.dataset.ajaxFrameActiveButtonName;
		}
		
		//return _linkclick.apply(that, [e]);
		if(e.preventDefault)
			e.preventDefault();
		else
			e.returnValue = false;
		
		//Construct a query string from the form (@todo the button clicked will not get submitted!)
		var queryString = [];
		forEach(form.elements, function(input){
			if(input.name && (input.type.toLowerCase() != 'submit' || input.name == buttonName) && !input.disabled){
				queryString.push(encodeURIComponent(input.name) + '=' + encodeURIComponent(input.value));
			}
		});
		
		//Construct the URL to navigate to
		var parsedURL = parse_url(form.action);
		if(parsedURL && parsedURL.host){
			var query = '?' + (parsedURL.query || '');
			if(query.length > 1)
				query += '&';
			query += queryString.join('&');
			var hash = parsedURL.fragment ? '#' + parsedURL.fragment : '';
			that.navigate(parsedURL.main + query + hash);
		}
		e.preventDefault();
		return false;
	};
	
	if(el.addEventListener){
		el.addEventListener('click', clickHandler, false);
		el.addEventListener('submit', submitHandler, false);
	}
	else if(el.attachEvent) {
		el.attachEvent('onclick', clickHandler);
		forEach(el.getElementsByTagName('form'), function(el){
			el.attachEvent('onsubmit', submitHandler);
		});
	}
}


/**
 * Take the JSON representation of the DOM and create real DOM nodes out of it
 * @todo Make part of AjaxFrame.instance.prototype
 * @this {AjaxFrame.Instance}
 * @private
 */
AjaxFrame.Instance.prototype._buildDOM = function _buildDOM(elObj){
	var el, that = this;
	
	//Create a SWF, assuming that object tags only embed SWFs
	if(elObj.name == 'object'){
		//var placeholder = document.createComment('<script> gets inserted here after DOM is built');
		var placeholder = document.createElement('span'); //temp-element
		if(!elObj.attrs.id){
			elObj.attrs.id = placeholder.id = "ajaxframe-swfobject-" + tempID;
			tempID++;
		}
		else {
			placeholder.id = elObj.attrs.id;
		}
		
		//Gather params
		var params = {};
		if(elObj.children){
			forEach(elObj.children, function(childEl){
				if(childEl.name == 'param'){
					params[childEl.attrs.name] = childEl.attrs.value;
				}
			});
		}
		
		//swfobject.createSWF(, tempEl.id);
		this._pendingNodes.push({
			type:'swf',
			params:params,
			attrs:elObj.attrs,
			placeholder:placeholder
		});
		return placeholder;
	}
	//Handle styles: IE doesn't like xbCreateElement for <style> elements
	else if(elObj.name == 'style'){
		el = document.createElement('style');
		forIn(elObj.attrs, function(name, value){
			el.setAttribute(name, value);
		});
		
		//Gather up all of the text to append
		if(elObj.children){
			var cssText = '';
			forEach(elObj.children, function(child){
				if(typeof child == 'string')
					cssText += child;
			});
			if(el.styleSheet) //IE way
				el.styleSheet.cssText = cssText;
			else //standard way
				el.appendChild(document.createTextNode(cssText));
		}
		return el;
	}
	//Handle scripts
	else if(elObj.name == 'script'){
		var placeholder = document.createComment('Prevented embedding script because allowScripting is set to ' + this.allowScripting);
		
		//Get all of the text contents
		var text = '';
		if(elObj.children){
			forEach(elObj.children, function(node){
				text += node;
			});
		}
		
		this._pendingNodes.push({
			type:'script',
			attrs:elObj.attrs,
			textContent:text,
			placeholder:placeholder
		});
		return placeholder;
	}
	//Handle all other elements
	else {
		el = xbCreateElement(elObj.name, elObj.attrs, that._isAllowingScripting);
		
		//Append comments, text nodes, and elements
		if(elObj.children){
			forEach(elObj.children, function(child){
				if(typeof child == 'string')
					el.appendChild(document.createTextNode(child)); //@todo: does not work for <style> in IE!
				else if(child.comment)
					el.appendChild(document.createComment(child.comment));
				else if(child.name)
					el.appendChild(that._buildDOM(child)); //el.appendChild(_buildDOM.apply(that, [child]));
				else
					throw Error("Unexpected node");
			});
		}
		return el;
	}
	throw Error("Unexpected element!");
};








/** Helper functions **********************************************************/




/**
 * Obviously
 * @param {boolean} onlyIfBelowFold If this is true, then no scrolling will happen if the target element is below scrollTop
 */
function scrollToElement(el, onlyIfBelowFold){
	//Calculate the offsetTop
	var offsetTop = 0;
	var parent = el;
	while(parent){
		offsetTop += parent.offsetTop;
		parent = parent.offsetParent;
	}
	
	var scrollTop = document.documentElement.scrollTop || document.getElementsByTagName('body')[0].scrollTop;
	if(!onlyIfBelowFold || offsetTop < scrollTop){
		if(el.scrollIntoView)
			el.scrollIntoView();
		else
			self.scrollTo(0,offsetTop);
	}
}


/**
 * Get the href of an element if it has one (and if it does, then it's a link)
 */
function getLinkHref(el){
	if(!el)
		return null;
	var href;
	if(el.href)
		return el.href;
	else if(el.getAttributeNodeNS)
		return el.getAttributeNodeNS('http://www.w3.org/1999/xlink', 'href'); //will never be relative, thanks to proxy
	return null;
}


/**
 * i.e. PHP's, but without user/pass, and includes a new property
 * "main" which is everything without query or fragment
 * @see http://us3.php.net/parse_url
 * @returns {Object}
 */
function parse_url(url){
	var match = url.match(/^(((\w+)?:\/\/([^\/]+?)(?::(\d+))?)?(\/.*?)?)?(?:\?(.*?))?(?:#(.*))?$/);
	if(!match)
		return null;
	var result = {
		//basename
		//dirname
		main:match[1],
		scheme:match[3],
		host:match[4],
		port:match[5],
		path:match[6],
		query:match[7],
		fragment:match[8]
	};
	//alert(match[2])
	return result;
}


/**
 * Cross-browser createElement function (accounts for MSIE problems)
 * @param {string} nodeName
 * @param {Object} attrs
 * @param {boolean} isAllowScripting
 * @returns {Element}
 */
var xbCreateElement = (function(){
	try {
		var test = document.createElement('<div id="foo">');
	}
	catch(e){}
	
	if(test && test.nodeName.toLowerCase() == 'div' && test.id == 'foo'){
		return function(nodeName, attrs, isAllowScripting){
			var tag = '<' + nodeName;
			forIn(attrs, function(attrName, attrValue){
				if(!/^on/i.test(attrName) || isAllowScripting){
					tag += " " + attrName + '="' + attrValue.replace(/"/g, '&quot;').replace(/</g, '&lt;') + '"';
				}
			});
			tag += '>';
			return document.createElement(tag);
		}
	}
	else {
		return function(nodeName, attrs, isAllowScripting){
			var el = document.createElement(nodeName);
			forIn(attrs, function(attrName, attrValue){
				if(/^on/i.test(attrName)){
					if(isAllowScripting){
						el[attrName] = new Function('event', attrValue);
						//el.setAttribute(key, value); //This does not work in IE7
					}
				}
				else {
					el.setAttribute(attrName, attrValue);
				}
			});
			return el;
		}
	}
})();


/**
 * Shortcut for doing a for-in loop
 */
function forIn(obj, callback){
	for(var key in obj){
		if(!obj.hasOwnProperty || obj.hasOwnProperty(key)){
			//try {
			callback(key, obj[key]);
			//}catch(e){alert(key)}
		}
	}
}

/**
 * Die for loops, die!
 */
var forEach = Array.forEach || function(object, block, context) {
	for (var i = 0, len = object.length; i < len; i++) {
		block.call(context, object[i], i, object);
	}
};



/*** INIT **************************************************************************************************/

//init();
//if(document.addEventListener){
//	document.addEventListener('DOMContentLoaded', init, false);
//}
//else {
//	
//}


AjaxFrame.init();





//document.addEventListener('DOMContentLoaded', function(){
//	document.write = function(){
//		console.error("document.write has been disabled.");
//	};
//}, false);

})();
