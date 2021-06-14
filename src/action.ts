import {Client, LogLevel} from '@notionhq/client/build/src';
import * as core from '@actions/core';
import type {IssuesEvent, IssuesOpenedEvent} from '@octokit/webhooks-definitions/schema';
import type {WebhookPayload} from '@actions/github/lib/interfaces';
import {properties} from './properties';
import type {InputPropertyValueMap} from '@notionhq/client/build/src/api-endpoints';
import {SelectOption} from '@notionhq/client/build/src/api-types';
import {markdownToBlocks, markdownToProperty} from './parser';

function parsePropertiesFromPayload(
  payload: IssuesEvent,
  statusOptions: SelectOption[]
): InputPropertyValueMap {
  const parsedBody = markdownToProperty(payload.issue.body);

  const result: InputPropertyValueMap = {
    Name: properties.title(payload.issue.title),
    Organization: properties.text(payload.organization?.login ?? ''),
    Repository: properties.text(payload.repository.name),
    Number: properties.number(payload.issue.number),
    Body: parsedBody,
    Assignees: properties.text(payload.issue.assignees.map(user => user.login).join(', ')),
    Milestone: properties.text(payload.issue.milestone?.title ?? ''),
    Labels: properties.text(payload.issue.labels?.map(label => label.name).join(', ') ?? ''),
    Author: properties.text(payload.issue.user.login),
    Created: properties.date(payload.issue.created_at),
    Updated: properties.date(payload.issue.updated_at),
    ID: properties.number(payload.issue.id),
  };

  const status = statusOptions.find(
    option => option.name.toLowerCase() === payload.issue.state?.toLowerCase()
  );

  if (status) {
    result['Status'] = properties.select(status.id, status.name, status.color);
  }

  return result;
}

interface IssueOpenedOptions {
  notion: {
    client: Client;
    databaseId: string;
  };
  payload: IssuesOpenedEvent;
}

async function getStatusOptions(client: Client, databaseId: string): Promise<SelectOption[]> {
  const db = await client.databases.retrieve({database_id: databaseId});
  const statusProperty = db.properties['Status'];
  if (statusProperty.type !== 'select') {
    throw new Error('`Status` property must be a select property.');
  }

  return statusProperty.select.options;
}

async function handleIssueOpened(options: IssueOpenedOptions) {
  const {notion, payload} = options;

  core.info(`Creating page for issue #${payload.issue.number}`);

  const statusOptions = await getStatusOptions(notion.client, notion.databaseId);

  const createdPage = await notion.client.pages.create({
    parent: {
      database_id: notion.databaseId,
    },
    properties: parsePropertiesFromPayload(payload, statusOptions),
  });

  const pageId = createdPage.id;

  const blocks = await markdownToBlocks(payload.issue.body, {
    repositoryUrl: payload.repository.git_url,
  });

  await notion.client.blocks.children.append({
    block_id: pageId,
    children: blocks,
  });
}

interface IssueEditedOptions {
  notion: {
    client: Client;
    databaseId: string;
  };
  payload: IssuesEvent;
}

async function handleIssueEdited(options: IssueEditedOptions) {
  const {notion, payload} = options;

  core.info(`Querying database for page with github id ${payload.issue.id}`);

  const query = await notion.client.databases.query({
    database_id: notion.databaseId,
    filter: {
      property: 'ID',
      number: {
        equals: payload.issue.id,
      },
    },
    page_size: 1,
  });

  if (query.results.length === 0) {
    core.warning(`Could not find page with github id ${payload.issue.id}`);
    return;
  }

  const pageId = query.results[0].id;

  core.info(`Query successful: Page ${pageId}`);
  core.info(`Updating page for issue #${payload.issue.number}`);

  const statusOptions = await getStatusOptions(notion.client, notion.databaseId);

  await notion.client.pages.update({
    page_id: pageId,
    properties: parsePropertiesFromPayload(payload, statusOptions),
  });
}

interface Options {
  notion: {
    token: string;
    databaseId: string;
  };
  github: {
    payload: WebhookPayload;
  };
}

export async function run(options: Options) {
  const {notion, github} = options;

  core.info('Starting...');

  const notionClient = new Client({
    auth: notion.token,
    logLevel: core.isDebug() ? LogLevel.DEBUG : LogLevel.WARN,
  });

  if (github.payload.action === 'opened') {
    await handleIssueOpened({
      notion: {
        client: notionClient,
        databaseId: notion.databaseId,
      },
      payload: github.payload as IssuesOpenedEvent,
    });
  } else {
    await handleIssueEdited({
      notion: {
        client: notionClient,
        databaseId: notion.databaseId,
      },
      payload: github.payload as IssuesEvent,
    });
  }

  core.info('Complete!');
}
