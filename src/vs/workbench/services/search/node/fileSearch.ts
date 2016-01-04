/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import fs = require('fs');
import paths = require('path');

import filters = require('vs/base/common/filters');
import arrays = require('vs/base/common/arrays');
import strings = require('vs/base/common/strings');
import glob = require('vs/base/common/glob');
import {IProgress} from 'vs/platform/search/common/search';

import extfs = require('vs/base/node/extfs');
import flow = require('vs/base/node/flow');
import {ISerializedFileMatch, IRawSearch, ISearchEngine} from 'vs/workbench/services/search/node/rawSearchService';

interface IStat {
	isDirectory: boolean;
	isSymbolicLink: boolean;
	mtime: number;
}

export class FileWalker {

	private static ENOTDIR = 'ENOTDIR';

	private config: IRawSearch;
	private filePattern: string;
	private excludePattern: glob.IExpression;
	private includePattern: glob.IExpression;
	private maxResults: number;
	private isLimitHit: boolean;
	private resultCount: number;
	private isCanceled: boolean;
	private searchInPath: boolean;
	private matchFuzzy: boolean;

	private walkedPaths: { [path: string]: boolean; };

	constructor(config: IRawSearch) {
		this.config = config;
		this.filePattern = config.filePattern;
		this.matchFuzzy = config.matchFuzzy;
		this.excludePattern = config.excludePattern;
		this.includePattern = config.includePattern;
		this.maxResults = config.maxResults || null;
		this.walkedPaths = Object.create(null);

		// Normalize file patterns to forward slashes
		if (this.filePattern && this.filePattern.indexOf(paths.sep) >= 0) {
			this.filePattern = strings.replaceAll(this.filePattern, '\\', '/');
			this.searchInPath = true;
		}
	}

	private resetState(): void {
		this.walkedPaths = Object.create(null);
		this.resultCount = 0;
		this.isLimitHit = false;
	}

	public cancel(): void {
		this.isCanceled = true;
	}

	private static statCache: { [path: string]: IStat } = Object.create(null);
	private static readdirCache: { [path: string]: string[] } = Object.create(null);

	public walk(rootFolders: string[], extraFiles: string[], onResult: (result: ISerializedFileMatch) => void, done: (error: Error, isLimitHit: boolean) => void): void {
		const statcacheFile = paths.join(rootFolders[0], '.statcache.json');
		const readdircacheFile = paths.join(rootFolders[0], '.readdircache.json');

		if (fs.existsSync(statcacheFile)) {
			FileWalker.statCache = JSON.parse(fs.readFileSync(statcacheFile, 'utf8'));
			FileWalker.readdirCache = JSON.parse(fs.readFileSync(readdircacheFile, 'utf8'));
		}

		this.walk2(rootFolders, extraFiles, onResult, (error, isLimitHit) => {
			if (!this.isCanceled) {
				fs.writeFileSync(statcacheFile, JSON.stringify(FileWalker.statCache));
				fs.writeFileSync(readdircacheFile, JSON.stringify(FileWalker.readdirCache));
			}

			done(error, isLimitHit);
		});
	}

	private walk2(rootFolders: string[], extraFiles: string[], onResult: (result: ISerializedFileMatch) => void, done: (error: Error, isLimitHit: boolean) => void): void {

		// Reset state
		this.resetState();

		// Support that the file pattern is a full path to a file that exists
		this.checkFilePatternAbsoluteMatch((exists) => {

			// Report result from file pattern if matching
			if (exists) {
				onResult({ path: this.filePattern });

				// Optimization: a match on an absolute path is a good result and we do not
				// continue walking the entire root paths array for other matches because
				// it is very unlikely that another file would match on the full absolute path
				return done(null, false);
			}

			// For each extra file
			if (extraFiles) {
				extraFiles.forEach(extraFilePath => {
					if (glob.match(this.excludePattern, extraFilePath)) {
						return; // excluded
					}

					// File: Check for match on file pattern and include pattern
					this.matchFile(onResult, paths.basename(extraFilePath), extraFilePath, extraFilePath /* no workspace relative path */);
				});
			}

			// For each root folder
			flow.parallel(rootFolders, (absolutePath, perEntryCallback) => {
				extfs.readdir(absolutePath, (error: Error, files: string[]) => {
					if (error || this.isCanceled || this.isLimitHit) {
						return perEntryCallback(null, null);
					}

					// Support relative paths to files from a root resource
					return this.checkFilePatternRelativeMatch(absolutePath, (match) => {
						if (this.isCanceled || this.isLimitHit) {
							return perEntryCallback(null, null);
						}

						// Report result from file pattern if matching
						if (match) {
							onResult({ path: match });
						}

						return this.doWalk(absolutePath, '', files, onResult, perEntryCallback);
					});
				});
			}, (err, result) => {
				done(err ? err[0] : null, this.isLimitHit);
			});
		});
	}

	private checkFilePatternAbsoluteMatch(clb: (exists: boolean) => void): void {
		if (!this.filePattern || !paths.isAbsolute(this.filePattern)) {
			return clb(false);
		}

		return fs.stat(this.filePattern, (error, stat) => {
			return clb(!error && !stat.isDirectory()); // only existing files
		});
	}

	private checkFilePatternRelativeMatch(basePath: string, clb: (matchPath: string) => void): void {
		if (!this.filePattern || paths.isAbsolute(this.filePattern) || !this.searchInPath) {
			return clb(null);
		}

		const absolutePath = paths.join(basePath, this.filePattern);

		return fs.stat(absolutePath, (error, stat) => {
			return clb(!error && !stat.isDirectory() ? absolutePath : null); // only existing files
		});
	}

	private doWalk(absolutePath: string, relativeParentPath: string, files: string[], onResult: (result: ISerializedFileMatch) => void, done: (error: Error, result: any) => void): void {

		// Execute tasks on each file in parallel to optimize throughput
		flow.parallel(files, (file: string, clb: (error: Error) => void): void => {

			// Check canceled
			if (this.isCanceled || this.isLimitHit) {
				return clb(null);
			}

			// If the user searches for the exact file name, we adjust the glob matching
			// to ignore filtering by siblings because the user seems to know what she
			// is searching for and we want to include the result in that case anyway
			let siblings = files;
			if (this.config.filePattern === file) {
				siblings = [];
			}

			// Check exclude pattern
			let relativeFilePath = strings.trim([relativeParentPath, file].join('/'), '/');
			if (glob.match(this.excludePattern, relativeFilePath, siblings)) {
				return clb(null);
			}

			// Use lstat to detect links
			let currentPath = paths.join(absolutePath, file);
			this.lstatCached(currentPath, (error, iStat) => {
				if (error || this.isCanceled || this.isLimitHit) {
					return clb(null);
				}

				// Directory: Follow directories
				if (iStat.isDirectory) {

					// to really prevent loops with links we need to resolve the real path of them
					return this.realPathIfNeeded(currentPath, iStat, (error, realpath) => {
						if (error || this.isCanceled || this.isLimitHit) {
							return clb(null);
						}

						if (this.walkedPaths[realpath]) {
							return clb(null); // escape when there are cycles (can happen with symlinks)
						}

						this.walkedPaths[realpath] = true; // remember as walked

						// Continue walking
						return this.readdirCached(currentPath, (error: Error, children: string[]): void => {
							if (error || this.isCanceled || this.isLimitHit) {
								return clb(null);
							}

							this.doWalk(currentPath, relativeFilePath, children, onResult, clb);
						});
					});
				}

				// File: Check for match on file pattern and include pattern
				else {
					if (relativeFilePath === this.filePattern) {
						return clb(null); // ignore file if its path matches with the file pattern because checkFilePatternRelativeMatch() takes care of those
					}

					this.matchFile(onResult, file, currentPath, relativeFilePath);
				}

				// Unwind
				return clb(null);
			});
		}, (error: Error[]): void => {
			if (error) {
				error = arrays.coalesce(error); // find any error by removing null values first
			}

			return done(error && error.length > 0 ? error[0] : null, null);
		});
	}

	private lstatCached(path: string, clb: (error: Error, stat?: IStat) => void): void {
		const cached = FileWalker.statCache[path];

		// NOT CACHED
		if (!cached) {
			// console.log("[CACHE MISS] STAT: " + path);

			return fs.lstat(path, (error, stat) => {
				const iStat = { isDirectory: stat.isDirectory(), mtime: stat.mtime.getTime(), isSymbolicLink: stat.isSymbolicLink() };
				FileWalker.statCache[path] = iStat;

				return clb(error, iStat);
			});
		}

		// CACHED DIR: needs revalidation
		if (cached.isDirectory) {
			// console.log("[CACHE REVAL] STAT FOLDER: " + path);

			return fs.lstat(path, (error, stat) => {
				if (error || stat.mtime.getTime() !== cached.mtime) {
					// console.log("[CACHE INVAL] STAT FOLDER: " + path);

					const children = FileWalker.readdirCache[path];
					if (children) {
						delete FileWalker.readdirCache[path];
						children.map(child => paths.join(path, child)).forEach(childPath => delete FileWalker.statCache[childPath]);
					}
				}

				const iStat = { isDirectory: stat.isDirectory(), mtime: stat.mtime.getTime(), isSymbolicLink: stat.isSymbolicLink() };
				FileWalker.statCache[path] = iStat;

				return clb(error, iStat);
			});
		}

		// CACHED FILE
		// console.log("[CACHE HIT] STAT FILE: " + path);
		return clb(null, cached);
	}

	private readdirCached(path: string, clb: (error: Error, files: string[]) => void): void  {
		const cached = FileWalker.readdirCache[path];

		// NOT CACHED
		if (!cached) {
			// console.log("[CACHE MISS] READDIR: " + path);
			return extfs.readdir(path, (error, files) => {
				FileWalker.readdirCache[path] = files;

				return clb(error, files);
			});
		}

		// CACHED
		// console.log("[CACHE HIT] READDIR: " + path);

		return clb(null, cached);
	}

	private matchFile(onResult: (result: ISerializedFileMatch) => void, basename: string, absolutePath: string, relativePath: string): void {
		if (this.isFilePatternMatch(basename, relativePath) && (!this.includePattern || glob.match(this.includePattern, relativePath))) {
			this.resultCount++;

			if (this.maxResults && this.resultCount > this.maxResults) {
				this.isLimitHit = true;
			}

			if (!this.isLimitHit) {
				onResult({
					path: absolutePath
				});
			}
		}
	}

	private isFilePatternMatch(name: string, path: string): boolean {

		// Check for search pattern
		if (this.filePattern) {
			const res = filters.matchesFuzzy(this.filePattern, this.matchFuzzy || this.searchInPath ? path : name, this.matchFuzzy);

			return !!res && res.length > 0;
		}

		// No patterns means we match all
		return true;
	}

	private realPathIfNeeded(path: string, lstat: IStat, clb: (error: Error, realpath?: string) => void): void {
		if (lstat.isSymbolicLink) {
			return fs.realpath(path, (error, realpath) => {
				if (error) {
					return clb(error);
				}

				return clb(null, realpath);
			});
		}

		return clb(null, path);
	}
}

export class Engine implements ISearchEngine {
	private rootFolders: string[];
	private extraFiles: string[];
	private walker: FileWalker;

	constructor(config: IRawSearch) {
		this.rootFolders = config.rootFolders;
		this.extraFiles = config.extraFiles;

		this.walker = new FileWalker(config);
	}

	public search(onResult: (result: ISerializedFileMatch) => void, onProgress: (progress: IProgress) => void, done: (error: Error, isLimitHit: boolean) => void): void {
		this.walker.walk(this.rootFolders, this.extraFiles, onResult, done);
	}

	public cancel(): void {
		this.walker.cancel();
	}
}