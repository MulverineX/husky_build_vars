const DEVICE = 'husky'

const build_vars = {
    MANUFACTURER: 'Google',
    MODEL: 'Pixel 8 Pro',
    FINGERPRINT: '',
    BRAND: 'google',
    PRODUCT: 'husky_beta',
    DEVICE: 'husky',
    RELEASE: '',
    ID: '',
    INCREMENTAL: '',
    TYPE: 'user',
    TAGS: 'release-keys',
    SECURITY_PATCH: '',
}

const { load } = require('cheerio')
const StreamZip = require('node-stream-zip')
const { withMountedDisk } = require('ext2fs')
const { FileDisk, withOpenFile } = require('file-disk')

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import stream from 'node:stream'
import type cheerioModule from 'cheerio'
import type { StreamZipAsync } from 'node-stream-zip'

const loadCheerio = load as typeof cheerioModule['load']

const cheerio = loadCheerio('<html></html>', { '_useHtmlParser2': true })

const versions_page = cheerio(await (await fetch('https://developer.android.com/about/versions')).text())

const version_link = versions_page.find('div.devsite-mobile-nav-bottom > ul > li:nth-child(2) > a')!.attr('href')!

build_vars.RELEASE = `${version_link.slice(-2)}`

const release_page = cheerio(await (await fetch(`https://developer.android.com${version_link}`)).text())

const beta_link = release_page.find('div.devsite-mobile-nav-bottom > ul:nth-child(1) > li.devsite-nav-item.devsite-nav-expandable.devsite-nav-accordion.devsite-nav-preview > div > ul > li:nth-child(2) > a')!.attr('href')!

const beta_page = cheerio(await (await fetch(`https://developer.android.com${beta_link}`)).text())

const stupid_iterator = beta_page.find('#gc-wrapper > main > devsite-content > article > div.devsite-article-body.clearfix > p > a')

let beta_images_link: string | undefined

console.log(stupid_iterator.length)

for (let i = 0; i < stupid_iterator.length; i++) {
    const element = stupid_iterator[i]! as any

    if (element.children && element.children[0] && element.children[0].data === 'Factory images for Google Pixel') {
        beta_images_link = element.attribs.href
        break
    }
}

if (!beta_images_link) {
    throw new Error('Could not find beta images link')
}

const beta_images_page = cheerio(await (await fetch(`https://developer.android.com${beta_images_link}`)).text())



const device_image = (beta_images_page.find(`#${DEVICE} > td:nth-child(2) > button`)! as any)[0].children[0].data

const current_image = Bun.file('current_image')

/* @ts-ignore */
ReadableStream.prototype[Symbol.asyncIterator] = async function* () {
    const reader = this.getReader()
    try {
        while (true) {
            const { done, value } = await reader.read()
            if (done) return
            yield value
        }
    }
    finally {
        reader.releaseLock()
    }
}

if (await current_image.text() === device_image) {
    console.log('No new image available')
} else {
    const device_image_link = `https://dl.google.com/developers/android/vic/images/factory/${device_image}`

    const save_image_id = current_image.writer()

    save_image_id.write(device_image)

    await save_image_id.end()

    console.log(`New image available: ${device_image_link}`)

    console.log('Downloading...')

    const downloader = async () => {
        const image = (await fetch(device_image_link)).body!

        // @ts-ignore
        return new Promise((res, rej) => stream.Readable.fromWeb(image).pipe(fs.createWriteStream('image.zip')).on('finish', () => { res() }).on('error', rej))
    }

    const image_file = Bun.file('image.zip')

    if (image_file.size < 3000000000) {
        await downloader()

        console.log('Downloaded')
    } else {
        console.log('Already downloaded')
    }

    console.log('Extracting...')

    if (!await fsp.exists('image')) {
        await fsp.mkdir('image')
    }

    const zip = new StreamZip.async({ file: 'image.zip' }) as StreamZipAsync

    const entries = await zip.entries()

    let internal_image = ''

    for (const entry of Object.values(entries)) {
        if (!entry.isDirectory && entry.name.includes('/image-')) {
            internal_image = entry.name
            break
        }
    }

    console.log(internal_image)

    await zip.extract(internal_image, 'image')

    await zip.close()

    const internal_zip = new StreamZip.async({ file: `image/${internal_image.split('/')[1]}` }) as StreamZipAsync

    await internal_zip.extract('system.img', 'image')

    await internal_zip.close()

    await Bun.$`7z x image/system.img system/build.prop`

    console.log('Extracted')

    console.log('Parsing build.prop...')

    const build_prop = (await Bun.file('system/build.prop').text()).split('\n')

    for (const line of build_prop) {
        if (line.startsWith('ro.system.build.fingerprint=')) {
            build_vars.FINGERPRINT = line.split('=')[1]
        } else if (line.startsWith('ro.system.build.id=')) {
            build_vars.ID = line.split('=')[1]
        } else if (line.startsWith('ro.system.build.version.incremental=')) {
            build_vars.INCREMENTAL = line.split('=')[1]
        } else if (line.startsWith('ro.build.version.security_patch=')) {
            build_vars.SECURITY_PATCH = line.split('=')[1]
        }

        if (build_vars.FINGERPRINT !== '' && build_vars.ID !== '' && build_vars.INCREMENTAL !== '' && build_vars.SECURITY_PATCH !== '') {
            break
        }
    }

    console.log('Parsed')

    console.log(build_vars)

    console.log('Writing...')

    const spoof_build_vars = Bun.file('spoof_build_vars').writer()

    const string_build_vars = Object.entries(build_vars).map(([key, value]) => `${key}=${value}`).join('\n')

    spoof_build_vars.write(string_build_vars)

    await spoof_build_vars.end()

    console.log('Build vars written')

    console.log('Notifying...')

    await fetch(
        process.env.DISCORD_WEBHOOK!,
        {
            method: 'POST',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                content: '<@178551656714076161> Play Integrity Memes\n\n```' + string_build_vars + '```'
            })
        }
    )

    console.log('Notified. Done!')
}

