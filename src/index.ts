import * as dotenv from 'dotenv'
dotenv.config()

import {
  LCDClient,
  MnemonicKey,
  Wallet,
  MsgSwap,
  Coin,
  Tx,
  isTxError,
  AccAddress,
  Numeric,
} from '@terra-money/terra.js'

import { promisify } from 'util'
import axios from 'axios'
import * as http from 'http'
import * as https from 'https'
import * as Bluebird from 'bluebird'
import * as redis from 'redis'

const ax = axios.create({
  httpAgent: new http.Agent({ keepAlive: true }),
  httpsAgent: new https.Agent({ keepAlive: true }),
  timeout: 15000,
})

const MNEMONIC = process.env.MNEMONIC
const SWAP_INTERVAL = parseInt(process.env.SWAP_INTERVAL as string)
const SWAP_AMOUNT_PER_PERIOD = process.env.SWAP_AMOUNT_PER_PERIOD as string
const SWAP_FROM_DENOM = process.env.SWAP_FROM_DENOM as string
const SWAP_TO_DENOM = process.env.SWAP_TO_DENOM as string
const NODE_URL = process.env.NODE_URL as string
const CHAIN_ID = process.env.CHAIN_ID as string
const SLACK_NOTIFICATION_URL = process.env.SLACK_NOTIFICATION_URL as string
const REDIS_URL = process.env.REDIS_URL as string

const REDIS_PREFIX = 'swapper_'
const REDIS_LAST_HEIGHT = 'last_height'

const redisClient = redis.createClient(REDIS_URL, { prefix: REDIS_PREFIX })
const getAsync: (key: string) => Promise<string | null> = promisify(redisClient.get).bind(
  redisClient
)
const setAsync: (key: string, val: string) => Promise<unknown> = promisify(redisClient.set).bind(
  redisClient
)

async function load_block_height(client: LCDClient): Promise<number> {
  const blockInfo = await client.tendermint.blockInfo()
  return parseInt(blockInfo.block.header.height)
}
async function load_swap_token_balance(
  client: LCDClient,
  address: AccAddress
): Promise<Numeric.Output> {
  const balance = (await client.bank.balance(address))[0].get(SWAP_FROM_DENOM)
  if (balance) {
    return balance.amount
  }

  return Numeric.parse(0)
}

async function create_swap_tx(wallet: Wallet, balance: Numeric.Output): Promise<Tx> {
  return await wallet.createAndSignTx({
    msgs: [
      new MsgSwap(
        wallet.key.accAddress,
        new Coin(
          SWAP_FROM_DENOM,
          balance.greaterThan(SWAP_AMOUNT_PER_PERIOD) ? SWAP_AMOUNT_PER_PERIOD : balance
        ),
        SWAP_TO_DENOM
      ),
    ],
  })
}

async function operation(client: LCDClient, wallet: Wallet) {
  const height = await load_block_height(client)
  const lastHeight = parseInt((await getAsync(REDIS_LAST_HEIGHT)) || '0')
  if (height <= lastHeight || (height + 1) % SWAP_INTERVAL !== 0) {
    return
  }

  // set to prevent duplicated execution
  await setAsync(REDIS_LAST_HEIGHT, height.toFixed())

  const balance = await load_swap_token_balance(client, wallet.key.accAddress)
  if (balance.isZero()) {
    return
  }

  const tx = await create_swap_tx(wallet, balance)
  const result = await client.tx.broadcastSync(tx)
  if (isTxError(result)) {
    throw new Error(`Failed with Error Code: ${result.code} and Error Log: ${result.raw_log}`)
  }

  const txHeight = await validateTx(client, result.txhash)
  console.info(`Tx Broadcasted => hash: ${result.txhash}, height: ${txHeight}`)
}

async function validateTx(client: LCDClient, txhash: string): Promise<number> {
  let height = 0
  let lastCheckHeight = 0

  while (!height) {
    await Bluebird.delay(3000)

    const lastBlock = await client.tendermint.blockInfo()
    const latestBlockHeight = parseInt(lastBlock.block.header.height, 10)

    if (latestBlockHeight <= lastCheckHeight) {
      continue
    }

    // set last check height to latest block height
    lastCheckHeight = latestBlockHeight

    // wait for indexing (not sure; but just for safety)
    await Bluebird.delay(500)

    await client.tx
      .txInfo(txhash)
      .then((txinfo) => {
        if (!txinfo.code) {
          height = txinfo.height
        } else {
          throw new Error(`validateTx: failed tx: code: ${txinfo.code}, raw_log: ${txinfo.raw_log}`)
        }
      })
      .catch((err) => {
        if (!err.isAxiosError) {
          console.error(err.message)
        }
      })
  }

  return height
}

async function main() {
  const client = new LCDClient({
    URL: NODE_URL,
    chainID: CHAIN_ID,
    gasPrices: { uluna: 0.01133 },
  })

  const wallet = client.wallet(
    new MnemonicKey({
      mnemonic: MNEMONIC,
    })
  )

  while (true) {
    await operation(client, wallet).catch(async (err) => {
      console.error(err)

      if (SLACK_NOTIFICATION_URL !== '') {
        await ax
          .post(SLACK_NOTIFICATION_URL, {
            text: `Swapper Error: ${err.message} '<!channel>'`,
          })
          .catch(() => {
            console.error('Slack Notification Error')
          })
      }
    })

    // sleep 60s after error
    await Bluebird.delay(1000)
  }
}

main()
