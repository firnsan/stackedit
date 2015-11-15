define([
    "underscore",
    "utils",
    "storage",
    "settings",
    "classes/Provider",
    "eventMgr",
    "fileMgr",
    "helpers/evernoteHelper"
], function(_, utils, storage, settings, Provider, eventMgr, fileMgr, evernoteHelper) {

    var PROVIDER_EVERNOTE= "evernote";

    var evernoteProvider = new Provider(PROVIDER_EVERNOTE, "Evernote");
    evernoteProvider.defaultPublishFormat = "template";

    function checkPath(path) {
        if(path === undefined) {
            return undefined;
        }
        if(!path.match(/^[^\\<>:"\|?\*]+$/)) {
            eventMgr.onError('"' + path + '" contains invalid characters.');
            return undefined;
        }
        if(path.indexOf("/") !== 0) {
            return "/" + path;
        }
        return path;
    }

    function createSyncIndex(path) {
        return "sync." + PROVIDER_EVERNOTE + "." + encodeURIComponent(path.toLowerCase());
    }

    var merge = settings.conflictMode == 'merge';
    function createSyncAttributes(path, versionTag, content, discussionListJSON) {
        discussionListJSON = discussionListJSON || '{}';
        var syncAttributes = {};
        syncAttributes.provider = evernoteProvider;
        syncAttributes.path = path;
        syncAttributes.version = versionTag;
        syncAttributes.contentCRC = utils.crc32(content);
        syncAttributes.discussionListCRC = utils.crc32(discussionListJSON);
        syncAttributes.syncIndex = createSyncIndex(path);
        if(merge === true) {
            // Need to store the whole content for merge
            syncAttributes.content = content;
            syncAttributes.discussionList = discussionListJSON;
        }
        return syncAttributes;
    }

    function importFilesFromPaths(paths) {
        evernoteHelper.downloadMetadata(paths, function(error, result) {
            if(error) {
                return;
            }
            evernoteHelper.downloadContent(result, function(error, result) {
                if(error) {
                    return;
                }
                var fileDescList = [];
                _.each(result, function(file) {
                    var parsedContent = evernoteProvider.parseContent(file.content);
                    var syncAttributes = createSyncAttributes(file.path, file.versionTag, parsedContent.content, parsedContent.discussionListJSON);
                    var syncLocations = {};
                    syncLocations[syncAttributes.syncIndex] = syncAttributes;
                    var fileDesc = fileMgr.createFile(file.name, parsedContent.content, parsedContent.discussionListJSON, syncLocations);
                    fileMgr.selectFile(fileDesc);
                    fileDescList.push(fileDesc);
                });
                if(fileDescList.length !== 0) {
                    eventMgr.onSyncImportSuccess(fileDescList, evernoteProvider);
                }
            });
        });
    }

    evernoteProvider.importFiles = function() {
        evernoteHelper.picker(function(error, paths) {
            if(error || paths.length === 0) {
                return;
            }
            var importPaths = [];
            _.each(paths, function(path) {
                var syncIndex = createSyncIndex(path);
                var fileDesc = fileMgr.getFileFromSyncIndex(syncIndex);
                if(fileDesc !== undefined) {
                    return eventMgr.onError('"' + fileDesc.title + '" is already in your local documents.');
                }
                importPaths.push(path);
            });
            importFilesFromPaths(importPaths);
        });
    };

    evernoteProvider.exportFile = function(event, title, content, discussionListJSON, callback) {
        var path = utils.getInputTextValue("#input-sync-export-evernote-path", event);
        path = checkPath(path);
        if(path === undefined) {
            return callback(true);
        }
        // Check that file is not synchronized with another one
        var syncIndex = createSyncIndex(path);
        var fileDesc = fileMgr.getFileFromSyncIndex(syncIndex);
        if(fileDesc !== undefined) {
            var existingTitle = fileDesc.title;
            eventMgr.onError('File path is already synchronized with "' + existingTitle + '".');
            return callback(true);
        }
        var data = evernoteProvider.serializeContent(content, discussionListJSON);
        evernoteHelper.upload(path, data, function(error, result) {
            if(error) {
                return callback(error);
            }
            var syncAttributes = createSyncAttributes(result.path, result.versionTag, content, discussionListJSON);
            callback(undefined, syncAttributes);
        });
    };

    evernoteProvider.syncUp = function(content, contentCRC, title, titleCRC, discussionList, discussionListCRC, syncAttributes, callback) {
        if(
            (syncAttributes.contentCRC == contentCRC) && // Content CRC hasn't changed
            (syncAttributes.discussionListCRC == discussionListCRC) // Discussion list CRC hasn't changed
        ) {
            return callback(undefined, false);
        }
        var uploadedContent = evernoteProvider.serializeContent(content, discussionList);
        evernoteHelper.upload(syncAttributes.path, uploadedContent, function(error, result) {
            if(error) {
                return callback(error, true);
            }
            syncAttributes.version = result.versionTag;
            if(merge === true) {
                // Need to store the whole content for merge
                syncAttributes.content = content;
                syncAttributes.discussionList = discussionList;
            }
            syncAttributes.contentCRC = contentCRC;
            syncAttributes.titleCRC = titleCRC; // Not synchronized but has to be there for syncMerge
            syncAttributes.discussionListCRC = discussionListCRC;

            callback(undefined, true);
        });
    };

    evernoteProvider.syncDown = function(callback) {
        var lastChangeId = storage[PROVIDER_EVERNOTE + ".lastChangeId"];
        evernoteHelper.checkChanges(lastChangeId, function(error, changes, newChangeId) {
            if(error) {
                return callback(error);
            }
            var interestingChanges = [];
            _.each(changes, function(change) {
                var syncIndex = createSyncIndex(change.path);
                var fileDesc = fileMgr.getFileFromSyncIndex(syncIndex);
                var syncAttributes = fileDesc && fileDesc.syncLocations[syncIndex];
                if(!syncAttributes) {
                    return;
                }
                // Store fileDesc and syncAttributes references to avoid 2 times search
                change.fileDesc = fileDesc;
                change.syncAttributes = syncAttributes;
                // Delete
                if(change.wasRemoved === true) {
                    interestingChanges.push(change);
                    return;
                }
                // Modify
                if(syncAttributes.version != change.stat.versionTag) {
                    interestingChanges.push(change);
                }
            });
            evernoteHelper.downloadContent(interestingChanges, function(error, changes) {
                if(error) {
                    callback(error);
                    return;
                }
                function mergeChange() {
                    if(changes.length === 0) {
                        storage[PROVIDER_EVERNOTE + ".lastChangeId"] = newChangeId;
                        return callback();
                    }
                    var change = changes.pop();
                    var fileDesc = change.fileDesc;
                    var syncAttributes = change.syncAttributes;
                    // File deleted
                    if(change.wasRemoved === true) {
                        eventMgr.onError('"' + fileDesc.title + '" has been removed from evernote.');
                        fileDesc.removeSyncLocation(syncAttributes);
                        return eventMgr.onSyncRemoved(fileDesc, syncAttributes);
                    }
                    var file = change.stat;
                    var parsedContent = evernoteProvider.parseContent(file.content);
                    var remoteContent = parsedContent.content;
                    var remoteDiscussionListJSON = parsedContent.discussionListJSON;
                    var remoteDiscussionList = parsedContent.discussionList;
                    var remoteCRC = evernoteProvider.syncMerge(fileDesc, syncAttributes, remoteContent, fileDesc.title, remoteDiscussionList, remoteDiscussionListJSON);
                    // Update syncAttributes
                    syncAttributes.version = file.versionTag;
                    if(merge === true) {
                        // Need to store the whole content for merge
                        syncAttributes.content = remoteContent;
                        syncAttributes.discussionList = remoteDiscussionList;
                    }
                    syncAttributes.contentCRC = remoteCRC.contentCRC;
                    syncAttributes.discussionListCRC = remoteCRC.discussionListCRC;
                    utils.storeAttributes(syncAttributes);
                    setTimeout(mergeChange, 5);
                }
                setTimeout(mergeChange, 5);
            });
        });
    };

    evernoteProvider.publish = function(publishAttributes, frontMatter, title, content, callback) {
        var path = checkPath(publishAttributes.path);
        if(path === undefined) {
            return callback(true);
        }
        evernoteHelper.upload(path, content, callback);
    };

    evernoteProvider.newPublishAttributes = function(event) {
        var publishAttributes = {};
        publishAttributes.path = utils.getInputTextValue("#input-publish-evernote-path", event);
        if(event.isPropagationStopped()) {
            return undefined;
        }
        return publishAttributes;
    };

    return evernoteProvider;
});
