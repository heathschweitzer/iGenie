<?php
/*
 * TODO: This should be revised to output DOM creation methods
 * 
 * This script takes one parameter "url" and takes the contents of the URL,
 * parses them with either an XML (or HTML?) parser, and returns the resultant
 * DOM tree as a serialized JSON data structure. An additional parameter "callback"
 * is used to support JSONP. Additionally, a parameter "auth"
 * could be (required to be) supplied which would associate the request with an
 * account, and thus the allowed URLs to proxy could be restricted as well as
 * the allowed HTTP referers.
 * 
 */

ob_start();
$contentType = '';
$charset = ''; #default

header("content-type:text/javascript; charset=utf-8");

$args = array('status' => 0);


try {
	if(!@preg_match("{^https?://}i", @$_GET['url']))
		throw new Exception('Required parameter "url" not supplied or invalid.');
	//if(!@preg_match('/^[\w\[\]]+(\.[\w\[\]]+)*$/', @$_GET['callback']))
		//throw new Exception("Valid callback not supplied.");

	$args['url'] = stripslashes($_GET['url']);
	
	$ch = curl_init($args['url']);
	curl_setopt_array($ch, array(
		CURLOPT_FOLLOWLOCATION => true,
		CURLOPT_MAXREDIRS => 10,
		CURLOPT_FORBID_REUSE => true,
		CURLOPT_HTTPGET => true,
		CURLOPT_RETURNTRANSFER => true,
		//CURLOPT_BUFFERSIZE //QUESTION: can we do incremental reading instead of all at once?
		//CURLOPT_CONNECTTIMEOUT
		CURLOPT_HTTPHEADER => array(
			"Accept: application/xhtml+xml,text/html"
			#"Accept: text/html"
		),
		CURLOPT_HEADERFUNCTION => 'parse_header',
		CURLOPT_USERAGENT => 'iGenie <https://github.com/ixoyefreak/iGenie>'
	));
	
	#http://ademar.name/blog/2006/04/curl-ssl-certificate-problem-v.html
	curl_setopt ($ch, CURLOPT_SSL_VERIFYPEER, TRUE); 
	curl_setopt ($ch, CURLOPT_CAINFO, dirname(__FILE__)."/cacert.pem");
	
	#Prevent against HTTP Response Splitting vulnerability
	if(preg_match('{^\w+:[^\r\n]+$}s', @$_SERVER['HTTP_REFERER']))
		curl_setopt($ch, CURLOPT_REFERER, $_SERVER['HTTP_REFERER']);
	if(preg_match('{^[^\r\n]+$}s', @$_SERVER['HTTP_USER_AGENT']))
		curl_setopt($ch, CURLOPT_USERAGENT, $_SERVER['HTTP_USER_AGENT']);
	if(preg_match('{^[^\r\n]+$}s', @$_SERVER['HTTP_ACCEPT_ENCODING']))
		curl_setopt($ch, CURLOPT_ENCODING, $_SERVER['HTTP_ACCEPT_ENCODING']);
		
	$body = curl_exec($ch);
	if($error = curl_error($ch))
		throw new Exception($error);
	
	//Parse out any xml-stylesheet directives
	//Parse out any external LINK or SCRIPT elements
	//Pass the LINK and SCRIPT elements in an array as the first argument to the callback function
	//Parse out inline STYLE and SCRIPT elements and turn them into external (referencing this ShepherdSyndication's server)
	//Serialize the BODY element or otherwise documentElement into a DIV which can then be returned as the second argument to the callback function
	
	$effectiveURL = curl_getinfo($ch, CURLINFO_EFFECTIVE_URL);
	if($effectiveURL)
		$args['url'] = $effectiveURL;
	$args['status'] = curl_getinfo($ch, CURLINFO_HTTP_CODE);
	//NOTE: We can't return an HTTP status error or else the JavaScript won't get fired
	//header('Server: Shepherd Syndication Proxy on ' . $_SERVER['SERVER_SOFTWARE'], true, $args['status'] ? $args['status'] : 400);
	
	if(!$body)
		throw new Exception("No content returned!");
	
	//if($code < 200 || $code >= 400)
	//	header("Warning: Server returned "); //throw new Exception("Server responded with error code $code.");
		
	#else if($charset != 'utf-8')
	#	throw new Exception("Only documents in utf-8 may currently be proxied. Content encoding was $charset.");
	
	$isXML = (strpos($contentType, 'xml') !== false);
	//Fix relative URLs
	

	//HTML Parse here!
	$document = new DOMDocument();
	if($charset)
		$document->encoding = $charset;
	if($isXML){
		if(!@$document->loadXML($body)){
			throw new Exception('XML Parse Error');
		}
	}
	else if(!@$document->loadHTML($body)){
		throw new Exception('XML Parse Error');
	}
	$charset = $document->encoding;
	
	//Get the base url
	$parsedBaseURL = parse_url($effectiveURL);
	$domain = '';
	if(@$parsedBaseURL['user'] || @$parsedBaseURL['pass']){
		$domain .= $parsedBaseURL['user'];
		if(@$parsedBaseURL['pass'])
			$domain .= ':' . $parsedBaseURL['pass'];
		$domain .= '@';
	}
	$domain .= $parsedBaseURL['scheme'] . '://' . $parsedBaseURL['host'];
	if(@$parsedBaseURL['port'])
		$domain .= ':' . $parsedBaseURL['port'];
	
	$baseURL = $domain . preg_replace('{[^/]+$}', '', preg_replace('{(\?|#).+}', '', @$parsedBaseURL['path']));
	
	//@TODO: We need to change baseURL if there is a <base> element or an xml:base attribute
	
	
	$xpath = new DOMXPath($document);
	$xpath->registerNamespace('html', 'http://www.w3.org/1999/xhtml');
	$xpath->registerNamespace('xlink', 'http://www.w3.org/1999/xlink');
	
	//Remove relative paths
	$attrs = $xpath->query('//@href|//@src|//@action'); //|//@xlink:href
	foreach($attrs as $attr){
		if(!preg_match('{^\w+://}', $attr->nodeValue)){
			$value = $attr->nodeValue;
			
			#in-document fragments
			if(substr($value, 0, 1) == '#'){
				//$attr->parentNode->setAttributeNS($attr->namespaceURI, $attr->localName, preg_replace('{#.*$}', '', $effectiveURL) . $attr->nodeValue);
				$value = preg_replace('{#.*$}', '', $effectiveURL) . $value;
			}
			#root referencing
			else if(substr($attr->nodeValue, 0, 1) == '/'){
				//$attr->parentNode->setAttributeNS($attr->namespaceURI, $attr->localName, $domain . $attr->nodeValue);
				$value = $domain . $value;
			}
			#relative
			else if(substr($attr->nodeValue, 0, 1) == '.'){
				$value = $baseURL . $value;
				$count = 1;
				while($count)
					$current = preg_replace('{([^/]+/)?\.\./}', '', $current, 1, $count);
				$current = str_replace('./', '', $current);
				$current = preg_replace('{//+}', '/', $current);
				//$attr->parentNode->setAttributeNS($attr->namespaceURI, $attr->localName, $current);
			}
			else {
				//$attr->parentNode->setAttributeNS($attr->namespaceURI, $attr->localName, $baseURL . $attr->nodeValue);
				$value = $baseURL . $attr->nodeValue;
			}
			$attr->parentNode->setAttributeNS($attr->namespaceURI, $attr->localName, $value);
		}
	}
	
	//Get stylesheets
	$styles = $xpath->query('//html:style|//style');
	foreach($styles as $style){
		$css = preg_replace_callback('{@import\s*("|\')(.+?)\\1}', 'absolute_css_import_callback', $style->textContent);
		while($style->firstChild)
			$style->removeChild($style->firstChild);
		$style->appendChild($document->createTextNode($css));
	}
	

	$bodyEl = $document->getElementsByTagName('body')->item(0);
	if(!$bodyEl)
		throw new Exception('No BODY element exists');
	

	//Fix PRE elements for IE
	$pres = $xpath->query('//html:pre|//pre');
	foreach($pres as $pre){
		foreach($xpath->query('.//text()', $pre) as $text){
			$frag = $document->createDocumentFragment();
			foreach(preg_split("{(\r?\n)}", $text->nodeValue, -1, PREG_SPLIT_DELIM_CAPTURE) as $line){
				if($line == "\r\n" || $line == "\n"){
					$frag->appendChild($document->createElement('br'));
				}
				else {
					foreach(preg_split("{(\t)}", $line, -1, PREG_SPLIT_DELIM_CAPTURE) as $token){
						if($token == "\t"){
							$frag->appendChild($document->createTextNode("\xC2\xA0\xC2\xA0\xC2\xA0\xC2\xA0"));
						}
						else {
							$frag->appendChild($document->createTextNode($token));
						}
					}
				}
			}
			$text->parentNode->replaceChild($frag, $text);
		}
	}

	//Node name for root element
	$rootElementNodeName = 'div';
	if(isset($_GET['rootElementNodeName']) && preg_match('/^\w+$/', $_GET['rootElementNodeName'])){
		$rootElementNodeName = stripslashes($_GET['rootElementNodeName']);
	}
	
	//Replace the <body> with a <div> in the result
	$afBody = $document->createElement($rootElementNodeName);
	for($i = 0; $i < $bodyEl->attributes->length; $i++){
		$attr = $bodyEl->attributes->item($i);
		$afBody->setAttribute($attr->nodeName, $attr->nodeValue);
	}
	
	//Copy all of the nodes from the <body> to the <div>
	//@todo: this could be replaced with el.renameNode()
	while($bodyEl->childNodes->length){
		$afBody->appendChild($bodyEl->firstChild);
	}
	
	//echo serialize_DOM_element($afBody);
	$args['bodyObj'] = objectify_DOM_element($afBody); //echo "\n" . json_encode(objectify_DOM_element($afBody));
	
	$headObjs = array();
	$headEls = $xpath->query( $isXML ?
		'//html:head/html:link | //html:head/html:script | //html:head/html:style'
		:
		'//head/link | //head/script | //head/style'
	);
	if($headEls->length){
		foreach($headEls as $el)
			$headObjs[] = objectify_DOM_element($el);
	}
	
	if(!empty($headObjs))
		$args['headObjs'] = $headObjs; //echo ",\n" . json_encode($headObjs);
	
	curl_close($ch);
	

}
catch(Exception $e){
	ob_clean();
	$args['error'] = $e->getMessage();
}

if(isset($_GET['callback']))
	print stripslashes($_GET['callback']) . '(' . json_encode($args) . ');';
else
	print json_encode($args);

//DEBUG
//if(isset($_GET['callback'])){
//	print "\n\n";
//	print "/*\n";
//	print str_replace('*/', '* /', print_r($args, true));
//	print "*/\n";
//}




//Done!


function parse_header($ch, $header){
	global $contentType, $charset;
	if(preg_match("{^content-type\s*:\s*(\S+?)(?:;\s*charset=(\S+)|\s+)}i", strtolower($header), $matches)){
		if(@$matches[2]){
			$charset = $matches[2];
			#if($charset != 'utf-8')
			#	throw new Exception("Only documents in utf-8 may currently be proxied.");
		}
		$contentType = $matches[1];
		switch($matches[1]){
			case 'text/html':
			case 'application/xml':
			case 'text/xml':
			case 'application/xhtml+xml':
				
				break;
			default:
				throw new Exception('Unsupported mime type "' . $matches[1] . '".');
		}
	}
	else if(preg_match("{^(Last-Modified|ETag|Date|Server)\s*:}i", $header)){
		header($header);
	}
	return strlen($header);
}

function absolute_css_import_callback($matches){
	global $domain, $baseURL;
	
	$url = $matches[2];
	
	if(!preg_match('{^\w+://}', $url)){
		#root referencing
		if(substr($url, 0, 1) == '/'){
			$url = $domain . $url;
		}
		#relative
		else if(substr($url, 0, 1) == '.'){
			$url = $baseURL . $url;
			$count = 1;
			while($count)
				$url = preg_replace('{([^/]+/)?\.\./}', '', $url, 1, $count);
			$url = str_replace('./', '', $url);
			$url = preg_replace('{//+}', '/', $url);
		}
		else {
			$url = $baseURL . $url;
		}
	}
	return '@import "' . $url . '"';
}



/**
 * Take a DOM element and make an object which can be JSON serialized
 * @param DOMElement $el  The node to convert to an object
 * @param boolean $isPreserveWhitespace  If not within a PRE element, then whitespace is normalized; needed for IE
 * @todo Make sure that response is Gzipped!
 */
function objectify_DOM_element($el, $isPreserveWhitespace = false){
	static $whiteSpacePreserve = 0;
	global $charset;
	
	//$pad = str_repeat("\t", $depth);
	$elObj = new stdClass();
	$elObj->name = str_replace('default:', '', $el->nodeName);
	switch(strtolower($elObj->name)){
		case 'script':
		case 'pre':
			$isPreserveWhitespace = true;
	}
	
	//Gather up all of the attributes
	if($el->attributes->length){
		$elObj->attrs = array();
		foreach($el->attributes as $attr)
			$elObj->attrs[$attr->nodeName] = $attr->nodeValue;
	}
	
	//Gather up all of the chuld nodes
	if($el->childNodes->length){
		$elObj->children = array();
		foreach($el->childNodes as $childNode){
			switch($childNode->nodeType){
				case 1:
					$elObj->children[] = objectify_DOM_element($childNode, $isPreserveWhitespace);
					break;
				case 3:
				case 4:
					$elObj->children[] = $isPreserveWhitespace ? $childNode->nodeValue : (preg_replace('/\s+/', ' ', $childNode->nodeValue));
					break;
				#case 7:
				#	$childs[] = "{$pad}[\"?" . walk_dom_tree_cleanupstring($node->nodeName) . "\", \"" . walk_dom_tree_cleanupstring($node->nodeValue) . '"]';
				#	break;
				case 8:
					//$childs[] = "{$pad}['!',\"" . walk_dom_tree_cleanupstring($node->nodeValue) . '"]';
					$elObj->children[] = array(
						'comment' => array($childNode->nodeValue)
					);
					break;
			}
		}
	}
	
	return $elObj;
}
