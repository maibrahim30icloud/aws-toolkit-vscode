/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { RegionSubmenu, RegionSubmenuResponse } from '../shared/ui/common/regionSubmenu'
import { Ec2Selection, getInstancesFromRegion } from './utils'
import { DataQuickPickItem } from '../shared/ui/pickerPrompter'
import { Ec2Instance } from '../shared/clients/ec2Client'
import { isValidResponse } from '../shared/wizards/wizard'
import { CancellationError } from '../shared/utilities/timeoutUtils'

export class Ec2Prompter {
    public constructor() {}

    protected static asQuickPickItem(instance: Ec2Instance): DataQuickPickItem<string> {
        return {
            label: '$(terminal) \t' + (instance.name ?? '(no name)'),
            detail: instance.InstanceId,
            data: instance.InstanceId,
        }
    }

    protected static getSelectionFromResponse(response: RegionSubmenuResponse<string>): Ec2Selection {
        return {
            instanceId: response.data,
            region: response.region,
        }
    }

    public async promptUser(): Promise<Ec2Selection> {
        const prompter = this.createEc2ConnectPrompter()
        const response = await prompter.prompt()

        if (isValidResponse(response)) {
            return Ec2Prompter.getSelectionFromResponse(response)
        } else {
            throw new CancellationError('user')
        }
    }

    private createEc2ConnectPrompter(): RegionSubmenu<string> {
        return new RegionSubmenu(
            async region =>
                (await getInstancesFromRegion(region)).map(instance => Ec2Prompter.asQuickPickItem(instance)).promise(),
            { title: 'Select EC2 Instance', matchOnDetail: true },
            { title: 'Select Region for EC2 Instance' },
            'Instances'
        )
    }
}
