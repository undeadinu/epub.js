EPUBJS.Book = function(bookPath, options){
	
	var book = this;
	
	this.settings = _.defaults(options || {}, {
	  element : false,
	  storage: false, //-- true (auto) or false (none) | override: 'ram', 'websqldatabase', 'indexeddb', 'filesystem'
	  saved : false,
	  online : true,
	  contained : false,
	  width : false,
	  height: false,
	  spreads: true,
	  responsive: true,
	  version: 1,
	  restore: true
	});
	
	this.settings.EPUBJSVERSION = EPUBJS.VERSION;
	
	this.spinePos = 0;
	this.stored = false;
	
	//-- All Book events for listening
	/*
		book:resized
		book:stored
		book:online
		book:offline
		book:pageChanged
		book:chapterDisplayed
	*/
	
	//-- All hooks to add functions (with a callback) to 
	this.hooks = {
		"beforeChapterDisplay" : []
	};
	
	//-- Get pre-registered hooks
	this.getHooks();
			
	this.online = this.settings.online || navigator.onLine;
	this.networkListeners();
		
	//-- Determine storage method
	//-- Override options: none | ram | websqldatabase | indexeddb | filesystem
	
	if(this.settings.storage != false ){
		this.storage = new fileStorage.storage(this.settings.storage);
	}
	
	this.ready = {
		manifest: new RSVP.Promise(),
		spine: new RSVP.Promise(),
		metadata: new RSVP.Promise(),
		cover: new RSVP.Promise(),
		toc: new RSVP.Promise()
	};
	
	this.ready.all = RSVP.all(_.values(this.ready));
	
	// BookUrl is optional, but if present start loading process
	if(bookPath) {
		this.opened = this.open(bookPath);
	}
	
	// Likewise if an element is present start rendering process
	if(this.settings.element) {
		this.opened.then(function(){
			this.rendered = this.renderTo(el);
		});
	}
	
	//-- Listen for these promises:
	//-- book.opened.then()
	//-- book.rendered.then()

}


//-- Check bookUrl and start parsing book Assets or load them from storage 

EPUBJS.Book.prototype.open = function(bookPath, forceReload){
	var book = this,
		opened;
	
	//-- Get a absolute URL from the book path
	this.bookUrl = this.urlFrom(bookPath);
	
	//-- Remove the previous settings and reload
	if(forceReload){
		this.removeSavedSettings();
	}
	
	//-- Check for a saved settings object, with the same url and version
	if(this.isSaved()){ 
		
		//-- Apply settings, keeping newer ones
		this.applySavedSettings();
		
		if(this.settings.restore){
			
			//-- Will load previous package json, or re-unpack if error
			opened = this.restore();

		}else{
			
			//-- Get package information from epub opf
			opened = this.unpack();
			
		}
		
	} else if(this.settings.contained || this.isContained(this.bookUrl)){
		
		
		this.settings.contained = this.contained = true;
		this.settings.restore = true;
		
		return; //-- TODO: this need to be fixed and tested before enabling
		opened = this.unarchive(this.bookUrl).then(function(){
			return book.unpack();
		});
		
	}else{
		
		//-- Get package information from epub opf
		opened = book.unpack();
	}

	//-- If there is network connection, store the books contents
	if(this.online && this.settings.storage && !this.settings.contained){
		if(!this.settings.stored) opened.then(book.storeOffline());
	}
	
	return opened;

}

EPUBJS.Book.prototype.unpack = function(containerPath){
	var book = this,
		parse = new EPUBJS.Parser(),
		containerPath = containerPath || "META-INF/container.xml";

	//-- Return chain of promises
	return book.loadXml(book.bookUrl + containerPath).
		   then(function(containerXml){
			  return parse.container(containerXml); // Container has path to content
		   }).
		   then(function(paths){
			  book.settings.contentsPath = book.bookUrl + paths.basePath;
			  book.settings.packageUrl = book.bookUrl + paths.packagePath;
			  return book.loadXml(book.settings.packageUrl); // Containes manifest, spine and metadata 
		   }).
		   then(function(packageXml){
			   return parse.package(packageXml, book.settings.contentsPath); // Extract info from contents
		   }).
		   then(function(contents){


			   book.contents = contents;

			   book.manifest = book.contents.manifest;
			   book.spine = book.contents.spine;
			   book.spineIndexByURL = book.contents.spineIndexByURL;
			   book.metadata = book.contents.metadata;

			   book.cover = book.contents.cover = book.settings.contentsPath + contents.coverPath;
			   
			   book.spineNodeIndex = book.contents.spineNodeIndex = contents.spineNodeIndex;
				
			   book.ready.manifest.resolve(book.contents.manifest);
			   book.ready.spine.resolve(book.contents.spine);
			   book.ready.metadata.resolve(book.contents.metadata);
			   book.ready.cover.resolve(book.contents.cover);

			   //-- Adjust setting based on metadata			   

			   //-- Load the TOC
			   book.settings.tocUrl = book.settings.contentsPath + contents.tocPath;
			   return book.loadXml(book.settings.tocUrl);
		   }).
		   then(function(tocXml){
			   return parse.toc(tocXml); // Grab Table of Contents
		   }).then(function(toc){
			   book.toc = book.contents.toc = toc;
			   book.ready.toc.resolve(book.contents.toc);
		   }).then(null, function(error) {
				console.log("Error:", error)
		   });


}

EPUBJS.Book.prototype.getMetadata = function() {
	return this.ready.metadata;
}

EPUBJS.Book.prototype.getToc = function() {
	return this.ready.toc;
}

/* Private Helpers */

//-- Listeners for browser events
EPUBJS.Book.prototype.networkListeners = function(){
	var book = this;

	window.addEventListener("offline", function(e) {
	  book.online = false;
	  book.trigger("book:offline");
	}, false);

	window.addEventListener("online", function(e) {
	  book.online = true;
	  book.trigger("book:online");
	}, false);
	
	window.addEventListener("beforeunload", function(e) {
	  book.saveSettings();
	  
	  if(book.settings.restore) {
		  book.saveContents();
	  }
	  
	  book.trigger("book:unload");
	}, false);
	
}

//-- Choose between a request from store or a request from network
EPUBJS.Book.prototype.loadXml = function(url){
	
	if(this.settings.storage) {
		return this.storage.getXml(url);
	}else{
		return EPUBJS.core.request(url, 'xml');
	} 
}

//-- Turns a url into a absolute url
EPUBJS.Book.prototype.urlFrom = function(bookPath){
	var absolute = bookPath.search("://") != -1,
		fromRoot = bookPath[0] == "/",
		location = window.location,
		//-- Get URL orgin, try for native or combine 
		origin = location.origin || location.protocol + "//" + location.host; 



	if(bookPath[bookPath.length - 1] != "/") bookPath += "/";

	//-- 1. Check if url is absolute
	if(absolute){
		return bookPath;
	}

	//-- 2. Check if url starts with /, add base url
	if(!absolute && fromRoot){
		return origin + bookPath; 
	}

	//-- 3. Or find full path to url and add that
	if(!absolute && !fromRoot){
		return origin + EPUBJS.core.folder(location.pathname) + bookPath;
	}

}


EPUBJS.Book.prototype.unarchive = function(bookPath){
	var unzipped;
	
	//-- Must use storage
	if(this.settings.storage == false ){
		this.settings.storage = true;
		this.storage = new fileStorage.storage();
	}
			
	unzipped = new EPUBJS.Unarchiver(bookPath);
	
	return unzipped;
}

//-- Checks if url has a .epub or .zip extension
EPUBJS.Book.prototype.isContained = function(bookUrl){
	var dot = bookUrl.lastIndexOf('.'),
		ext = bookUrl.slice(dot+1);

	if(ext && (ext == "epub" || ext == "zip")){
		return true;
	}

	return false;
}

//-- Checks if the book setting can be retrieved from localStorage
EPUBJS.Book.prototype.isSaved = function() {
	var bookKey = this.bookUrl + ":" + this.settings.version,
		storedSettings = localStorage.getItem(bookKey);

	if( !localStorage ||
		storedSettings === null) {
		return false;
	} else {
		return true;
	} 
}

//-- Remove save book settings
EPUBJS.Book.prototype.removeSavedSettings = function() {
	var bookKey = this.bookUrl + ":" + this.settings.version;
	
		localStorage.removeItem(bookKey);
		
		this.settings.stored = false; //TODO: is this needed?
}
		
EPUBJS.Book.prototype.applySavedSettings = function() {
		var bookKey = this.bookUrl + ":" + this.settings.version;
			stored = JSON.parse(localStorage.getItem(bookKey));
		
		if(EPUBJS.VERSION != stored.EPUBJSVERSION) return false;
		
		this.settings = _.defaults(this.settings, stored); 
				
		// if(this.settings.prevSpinePos) {
		// 	this.spinePos = this.settings.prevSpinePos;
		// 	this.settings = this.settings.prevChapterPos;
		// }


		//-- get previous saved positions
		// this.spinePos = parseInt(localStorage.getItem("spinePos")) || 0;
		// this.stored = parseInt(localStorage.getItem("stored")) || 0;
		
		//-- get previous saved paths
		// this.basePath = localStorage.getItem("basePath");
		// this.contentsPath = localStorage.getItem("contentsPath");
		
		//-- get previous saved content
		// this.metadata = JSON.parse(localStorage.getItem("metadata"));
		// this.assets = JSON.parse(localStorage.getItem("assets"));
		// this.spine = JSON.parse(localStorage.getItem("spine"));
		// this.spineIndexByURL = JSON.parse(localStorage.getItem("spineIndexByURL"));
		// this.toc = JSON.parse(localStorage.getItem("toc"));
		
		//-- Get previous page
		// this.prevChapterPos = parseInt(localStorage.getItem("chapterPos"));
		// this.prevDisplayedPages = parseInt(localStorage.getItem("displayedPages"));
		
}

EPUBJS.Book.prototype.saveSettings = function(){
	var bookKey = this.bookUrl + ":" + this.settings.version;
	
	if(this.render) {
		this.settings.previousLocationCfi = this.render.currentLocationCfi;
	}
		
	localStorage.setItem(bookKey, JSON.stringify(this.settings));

}

EPUBJS.Book.prototype.saveContents = function(){
	var contentsKey = this.settings.contentsPath + ":" + this.settings.version;

	localStorage.setItem(contentsKey, JSON.stringify(this.contents));

}

// EPUBJS.Book.prototype.chapterTitle = function(){
// 	return this.spine[this.spinePos].id; //-- TODO: clarify that this is returning title
// }

EPUBJS.Book.prototype.renderTo = function(el){
	var book = this;
	//-- ...	
	
	this.settings.element = el;

	
	return this.opened.
			then(function(){
				book.render = new EPUBJS.Renderer(book);
									
				return book.startDisplay();
			})
}

EPUBJS.Book.prototype.startDisplay = function(){
	var display;
	if( this.settings.previousLocationCfi) {
		
		display = this.displayChapter(this.settings.previousLocationCfi);
		
	}else{
		display = this.displayChapter(this.spinePos);
	}
	
	return display;
}

EPUBJS.Book.prototype.restore = function(){
	
	var book = this,
		contentsKey = this.settings.contentsPath + ":" + this.settings.version,
		promise = new RSVP.Promise(),
		fetch = ['manifest', 'spine', 'metadata', 'cover', 'toc', 'spineNodeIndex', 'spineIndexByURL'],
		reject = false,
		fromStore = localStorage.getItem(contentsKey);

	if(this.settings.contentsPath && fromStore){
		this.contents = JSON.parse(fromStore);
		
		fetch.forEach(function(item){
			book[item] = book.contents[item];
			if(!book[item]) {
				reject = true;
			}
		});
	}


	if(reject || !fromStore || !this.contents ){
		
		this.removeSavedSettings();
		  	
		return this.unpack();
		
	}else{
		this.ready.manifest.resolve(this.manifest);
		this.ready.spine.resolve(this.spine);
		this.ready.metadata.resolve(this.metadata);
		this.ready.cover.resolve(this.cover);
		this.ready.toc.resolve(this.toc);
		
		promise.resolve();
		return promise;
	}
	

}



EPUBJS.Book.prototype.displayChapter = function(chap, end){
	var book = this,
		render,
		cfi,
		pos;

	if(_.isNumber(chap)){
		pos = chap;
	}else{
		cfi = new EPUBJS.EpubCFI(chap);
		pos = cfi.spinePos;
	}
	
	
	if(pos >= this.spine.length){
		// console.log("Reached End of Book");
		return false;
	}

	if(pos < 0){
		// console.log("Reached Start of Book");
		return false;
	}
	
	//-- Set the book's spine position
	this.spinePos = pos;
	
	//-- Create a new chapter	
	this.chapter = new EPUBJS.Chapter(this.spine[pos]);
	
	render = book.render.chapter(this.chapter);
	
	if(cfi) {
		render.then(function(chapter){
			chapter.currentLocationCfi = chap;
			chapter.gotoCfiFragment(cfi);
		});
	} else if(end) {
		render.then(function(chapter){
			chapter.gotoChapterEnd();
		})
	}

	
	if(!this.settings.storage) {
		render.then(function(){
			book.preloadNextChapter();
		});
	}
	
	return render;
}

EPUBJS.Book.prototype.nextPage = function(){
	var next = this.render.nextPage();

	if(!next){
		return this.nextChapter();
	}
}

EPUBJS.Book.prototype.prevPage = function() {
	var prev = this.render.prevPage();
	
	if(!prev){
		return this.prevChapter();
	}
}

EPUBJS.Book.prototype.nextChapter = function() {
	this.spinePos++;

	return this.displayChapter(this.spinePos);
}

EPUBJS.Book.prototype.prevChapter = function() {
	this.spinePos--;

	return this.displayChapter(this.spinePos, true);
}

EPUBJS.Book.prototype.goto = function(url){
	var split = url.split("#"),
		chapter = split[0],
		section = split[1] || false,
		absoluteURL = (chapter.search("://") == -1) ? this.settings.contentsPath + chapter : chapter,
		spinePos = this.spineIndexByURL[absoluteURL],
		book;

	//-- If link fragment only stay on current chapter
	if(!chapter){
		spinePos = this.chapter.spinePos;
	}

	//-- Check that URL is present in the index, or stop
	if(typeof(spinePos) != "number") return false;

	if(spinePos != this.chapter.spinePos || !this.chapter){
		//-- Load new chapter if different than current
		return this.displayChapter(spinePos).then(function(){
			if(section) book.render.section(section);
		});
	}else{
		//-- Only goto section
		if(section) this.render.section(section);
		return new RSVP.Promise().resolve(this.currentChapter);
	}
}



EPUBJS.Book.prototype.preloadNextChapter = function() {
	var temp = document.createElement('iframe');
		next; 
	
		if(this.spinePos >= this.spine.length){
			return false;
		}
		
	next = new EPUBJS.Chapter(this.spine[this.spinePos + 1]);
	
	EPUBJS.core.request(next.href);
}


EPUBJS.Book.prototype.storeOffline = function() {
	var book = this,
		assets = _.values(this.manifest);
	
	//-- Creates a queue of all items to load
	return EPUBJS.storage.batch(assets).
			then(function(){
				book.settings.stored = true;
				book.trigger("book:stored");
			});
}

EPUBJS.Book.prototype.availableOffline = function() {
	return this.settings.stored > 0 ? true : false;
}

/*
EPUBJS.Book.prototype.fromStorage = function(stored) {
	
	if(this.contained) return;
	
	if(!stored){
		this.online = true;
		this.tell("book:online");
	}else{
		if(!this.availableOffline){
			//-- If book hasn't been cached yet, store offline
			this.storeOffline(function(){
				this.online = false;
				this.tell("book:offline");
			}.bind(this));
			
		}else{
			this.online = false;
			this.tell("book:offline");
		}
	}
	
}
*/


//-- Get pre-registered hooks
EPUBJS.Book.prototype.getHooks = function(){
	var that = this;
	
	plugTypes = _.values(this.hooks);
		
	plugTypes.forEach(function(plug){
		var type = plug.ident;
		plugs = _.values(EPUBJS.Hooks[type]);
		plugs.forEach(function(hook){
			that.registerHook(type, hook);
		});
	});
}

//-- Hooks allow for injecting async functions that must all complete before continuing 
//   Functions must have a callback as their first argument.
EPUBJS.Book.prototype.registerHook = function(type, toAdd){
	var that = this;
	
	if(typeof(this.hooks[type]) != "undefined"){
		
		if(typeof(toAdd) === "function"){
			this.hooks[type].push(toAdd);
		}else if(Array.isArray(toAdd)){
			toAdd.forEach(function(hook){
				that.hooks[type].push(hook);
			});
		}
		
	}else{
		//-- Allows for undefined hooks, but maybe this should error?
		this.hooks[type] = [func];
	}
}

EPUBJS.Book.prototype.triggerHooks = function(type, callback, passed){
	var hooks, count;

	if(typeof(this.hooks[type]) == "undefined") return false;

	hooks = this.hooks[type];
	
	count = hooks.length;

	function countdown(){
		count--;
		if(count <= 0 && callback) callback();
	}

	hooks.forEach(function(hook){
		hook(countdown, passed);
	});
}

//-- Enable binding events to book
RSVP.EventTarget.mixin(EPUBJS.Book.prototype);
