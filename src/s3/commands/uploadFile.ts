/*!
 * Copyright 2020 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */


import { S3 } from 'aws-sdk'
import * as path from 'path'
import { statSync } from 'fs'
import * as vscode from 'vscode'
import { ext } from '../../shared/extensionGlobals'
import { getLogger } from '../../shared/logger'
import { S3Node } from '../explorer/s3Nodes'
import { Commands } from '../../shared/vscode/commands'
import { Window } from '../../shared/vscode/window'
import * as telemetry from '../../shared/telemetry/telemetry'
import { readablePath } from '../util'
import { progressReporter } from '../progressReporter'
import { localize } from '../../shared/utilities/vsCodeUtils'
import { showErrorWithLogs, showOutputMessage } from '../../shared/utilities/messages'
import { createQuickPick, promptUser, verifySinglePickerOutput } from '../../shared/ui/picker'
import { addCodiconToString } from '../../shared/utilities/textUtilities'
import { S3Client } from '../../shared/clients/s3Client'
import { createBucketCommand } from './createBucket'
import { recordAwsRefreshExplorer } from '../../shared/telemetry/telemetry'
import { S3BucketNode } from '../explorer/s3BucketNode'
import { S3FolderNode } from '../explorer/s3FolderNode'





export interface FileSizeBytes {
    /**
     * Returns the file size in bytes.
     */
    (file: vscode.Uri): number
}

/**
 * Wizard to upload a file.
 * If the S3BucketNode | S3FolderNode is given, it asks for the file then uploads to node
 * If the node is not give, it asks for the file and also for a bucket, then uploads
 * 
 * @param s3Client account to upload the file to
 * 
 */
 export async function uploadFileCommand(
    s3Client: S3Client,
    nodeOrDocument?: S3BucketNode | S3FolderNode | vscode.Uri,
    fileSizeBytes: FileSizeBytes = statFile,
    getBucket = promptUserForBucket,
    getFile = getFileToUpload,
    window = Window.vscode(),
    outputChannel = ext.outputChannel,
    commands = Commands.vscode()
): Promise<void>{
    let key: string
    let bucket: S3.Bucket
    let file: vscode.Uri | undefined
    
    let isNode: boolean
    if (!nodeOrDocument) {
        isNode = false
    } else { 
        isNode = !!((nodeOrDocument as any).getChildren)
    }

    if (isNode) {
        const node = nodeOrDocument as S3BucketNode | S3FolderNode
        file = await getFile(undefined, window)
            if (!file) {
                showOutputMessage('No file selected, cancelling upload', outputChannel)
                getLogger().info('UploadFile cancelled')
                telemetry.recordS3UploadObject({ result: 'Cancelled' })
                return
            }
        key = node.path + path.basename(file.fsPath)
        bucket = { Name: node.bucket.name }
    } else {
        const document = nodeOrDocument as vscode.Uri
        while (true) {
            file = await getFile(document, window)
            if (file) {
                try{
                    const bucketResponse = await getBucket(s3Client)
                    if (bucketResponse === 'back'){
                        continue
                    }
                    if(bucketResponse == 'cancel'){
                        showOutputMessage('No bucket selected, cancelling upload', outputChannel)
                        getLogger().info('No bucket selected, cancelling upload')
                        telemetry.recordS3UploadObject({ result: 'Cancelled' })
                        return
                    }
                    
                    bucket = bucketResponse as S3.Bucket
                    key = path.basename(file.fsPath)
                    break
                } catch (e) {
                    telemetry.recordS3UploadObject({ result: 'Failed' })
                    getLogger().error('promptUserForBucket failed', e)
                    return
                }
            } else {
                //if file is undefined, means the back button was pressed(there is no step before) or no file was selected
                //thus break the loop of the 'wizard'
                showOutputMessage('No file selected, cancelling upload', outputChannel)
                getLogger().info('UploadFile cancelled')
                telemetry.recordS3UploadObject({ result: 'Cancelled' })
                return
            }
        }
    }
    const fileName = path.basename(file.fsPath)
    const destinationPath = readablePath({ bucket: {name: bucket.Name!}, path: key })
    

    try {
        showOutputMessage(`Uploading file from ${file} to ${destinationPath}`, outputChannel)
        const request = {
            bucketName: bucket.Name!,
            key: key,
            fileLocation: file,
            fileSizeBytes: fileSizeBytes(file),
            s3Client,
            window: window
        }

        await uploadWithProgress(request)
        showOutputMessage(`Successfully uploaded file ${destinationPath} to ${bucket.Name!}`, outputChannel)
        telemetry.recordS3UploadObject({ result: 'Succeeded' })
        recordAwsRefreshExplorer()
        commands.execute('aws.refreshAwsExplorer')
        return

    } catch (e) {
        getLogger().error(`Failed to upload file from ${file} to ${destinationPath}: %O`, e)
        showErrorWithLogs(localize('AWS.s3.uploadFile.error.general', 'Failed to upload file {0}', fileName), window)
        telemetry.recordS3UploadObject({ result: 'Failed' })
        return
    }
    
}

async function promptForFileLocation(window: Window): Promise<vscode.Uri | undefined> {
    const fileLocations = await window.showOpenDialog({
        openLabel: localize('AWS.s3.uploadFile.openButton', 'Upload'),
    })

    if (!fileLocations || fileLocations.length == 0) {
        return undefined
    }

    return fileLocations[0]
}

function statFile(file: vscode.Uri) {
    return statSync(file.fsPath).size
}


async function uploadWithProgress({
    bucketName,
    key,
    fileLocation,
    fileSizeBytes,
    s3Client,
    window
}:
    {
    bucketName: string,
    key: string,
    fileLocation: vscode.Uri,
    fileSizeBytes: number,
    s3Client: S3Client,
    window: Window
}): Promise<void>{
    return window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: localize('AWS.s3.uploadFile.progressTitle', 'Uploading {0}...', path.basename(fileLocation.fsPath)),
        },
        progress => {
            return s3Client.uploadFile({
                bucketName: bucketName,
                key: key,
                fileLocation,
                progressListener: progressReporter({ progress, totalBytes: fileSizeBytes }),
            })
        }
    )
}

interface BucketQuickPickItem extends vscode.QuickPickItem {
    bucket: S3.Bucket | undefined
}

// TODO:: extract and reuse logic from 
/**
 * Will display a quick pick with the list of all buckets owned by the user.
 * @param s3client client to get the list of buckets
 * @returns Bucket selected by the user, undefined if no bucket was selected or the quick pick was cancelled.
 * 
 * @throws Error if there is an error calling s3
 */
export async function promptUserForBucket(
    s3client: S3Client,
    window = Window.vscode(),
    promptUserFunction = promptUser,
    createBucket = createBucketCommand,
): Promise<S3.Bucket | string> {
    let allBuckets: S3.Bucket[]
    try{
        allBuckets = await s3client.listAllBuckets()
    } catch (e) {
        getLogger().error('Failed to list buckets from client321', e)
        window
        .showErrorMessage(
            localize(
                'AWS.message.error.promptUserForBucket.listBuckets',
                'Failed to list buckets from client, please try changing your region then try again',
            ),
            localize('AWS.message.prompt.changeS3RegionButton','Change default S3 region')
        )
        .then((selection: string | undefined) => {
            if (selection === 'Change default S3 region') {
                vscode.commands.executeCommand('workbench.action.openSettings', 'aws.s3.defaultRegion')
            } 
        })
        telemetry.recordS3UploadObject({ result: 'Failed' })
        throw new Error('Failed to list buckets from client456')
    }
    
    const s3Buckets = allBuckets.filter(bucket => {
        return bucket && bucket.Name
    }) as S3.Bucket[]

    
    const createNewBucket: BucketQuickPickItem = {
        label: localize('AWS.command.s3.createBucket',"Create new bucket"),
        bucket: undefined
    }
    const bucketItems: BucketQuickPickItem[] = s3Buckets.map(bucket => {
        return { 
            label: bucket.Name!,
            bucket
        }
    })

    const picker = createQuickPick({
        options: {
            canPickMany: false,
            ignoreFocusOut: true,
            title: localize('AWS.message.selectBucket','Select an S3 bucket to upload to'),
            step: 2,
            totalSteps: 2,
        },
        items: [...bucketItems, createNewBucket],
        buttons: [vscode.QuickInputButtons.Back]
    })
    const response = verifySinglePickerOutput(await promptUserFunction({
        picker: picker,
        onDidTriggerButton: (button, resolve, reject) => {
            if (button === vscode.QuickInputButtons.Back) {
                resolve([{
                    label: "back",
                    bucket: undefined
                }])
            }

        },
    })) 

    if (!response) {
        return 'cancel'
    }

    if (!response.bucket) {
        if (response.label === 'back') {
            return response.label
        }
        if (response.label === 'Create new bucket') {
            const s3Node = new S3Node(s3client)
            await createBucket(s3Node, window, Commands.vscode())
            return promptUserForBucket(s3client)
        }
    } else {
        return response.bucket
    }
    return 'cancel'
}

/**
 * Gets the open file in the current editor
 * Asks the user to browse for more files
 * If no file is open it prompts the user to select file
 * @param document document to use as currently open
 * 
 * @returns file selected by the user
 */
export async function getFileToUpload(
    document?: vscode.Uri,
    window = Window.vscode(),
    promptUserFunction = promptUser
): Promise<vscode.Uri| undefined> {
    
    let fileLocation: vscode.Uri | undefined

    if (!document) {
        fileLocation = await promptForFileLocation(window)
    } 
    else {
        fileLocation = document
        const fileNameToDisplay = path.basename(fileLocation.fsPath)

        const fileOption : vscode.QuickPickItem = { 
            label: addCodiconToString('file', fileNameToDisplay) 
        }
        const selectMore: vscode.QuickPickItem = {
            label: "Browse for more files..."
        }

        const picker = createQuickPick({
            options: {
                canPickMany: false,
                ignoreFocusOut: true,
                title: localize('AWS.message.selectFileUpload', 'Select a file to upload'), 
                step: 1,
                totalSteps: 2,
            },
            items: [fileOption, selectMore],
            buttons: [vscode.QuickInputButtons.Back]
        })

        
        const response = verifySinglePickerOutput(await promptUserFunction({
            picker: picker,
            onDidTriggerButton: (button, resolve, reject) => {
                if (button === vscode.QuickInputButtons.Back) {
                    resolve(undefined)
                }
            },
        }))

        if(!response){
            return
        }

        if (response?.label === 'Browse for more files...') {
            fileLocation = await promptForFileLocation(window)
        }

    }
    
    return fileLocation
}
